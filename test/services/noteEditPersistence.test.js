const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const SUMMARY =
  "## Overview\nWorkshop planning.\n\n## Decisions Made\nUse the small room.\n\n## Next steps\n- [ ] Alex sends the poll by Sunday.\n";
const EDITED =
  "## Overview\nWorkshop planning.\n\n## Next steps\n- [ ] Alex sends the poll by Sunday.\n";
const CONTENT = "My private reminder: bring a notebook.";
const TRANSCRIPT = JSON.stringify([{ speaker: "Alex", text: "I will send the poll by Sunday." }]);

test("note edits preserve separate stored fields, reopen correctly, and report failed saves", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ow-note-edit-test-"));
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "electron")
      return {
        app: { getPath: () => directory, getAppPath: () => process.cwd(), isReady: () => false },
      };
    return originalLoad.call(this, request, parent, isMain);
  };
  let database;
  try {
    const DatabaseManager = require("../../src/helpers/database.js");
    database = new DatabaseManager();
  } finally {
    Module._load = originalLoad;
  }
  t.after(() => {
    database.db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const note = database.saveNote("Workshop", CONTENT, "meeting").note;
  database.updateNote(note.id, { enhanced_content: SUMMARY, transcript: TRANSCRIPT });
  const pushes = [];
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        getNote: async (id) => database.getNote(id),
        updateNote: async (id, updates, options) => database.updateNote(id, updates, options),
      },
    },
  });
  const vite = await createRendererServer(t);
  const { syncService } = await vite.ssrLoadModule("/services/SyncService.ts");
  t.mock.method(syncService, "debouncedPush", (...args) => pushes.push(args));
  const { updateNoteTool } = await vite.ssrLoadModule("/services/tools/updateNoteTool.ts");
  const { getNoteTool } = await vite.ssrLoadModule("/services/tools/getNoteTool.ts");
  const { MAX_CONTENT_LENGTH } = await vite.ssrLoadModule("/services/tools/searchNotesTool.ts");

  await t.test(
    "get_note identifies personal content, summary and transcript separately",
    async () => {
      const result = await getNoteTool.execute({ id: note.id });
      assert.equal(result.data.content, CONTENT);
      assert.equal(result.data.summary, SUMMARY);
      assert.equal(result.data.transcript, "Alex: I will send the poll by Sunday.");
      assert.equal(result.data.transcript_truncated, false);
    }
  );
  await t.test("get_note cuts a long transcript and says so", async () => {
    const long = JSON.stringify(Array.from({ length: 100 }, () => ({ text: "Long meeting." })));
    database.updateNote(note.id, { transcript: long });
    const { data } = await getNoteTool.execute({ id: note.id });
    database.updateNote(note.id, { transcript: TRANSCRIPT });
    assert.equal(data.transcript.length, MAX_CONTENT_LENGTH);
    assert.equal(data.transcript_truncated, true);
  });
  await t.test(
    "removing a summary section changes only its stored field, including after reopen",
    async () => {
      const result = await updateNoteTool.execute({ id: note.id, summary: EDITED });
      assert.equal(result.success, true);
      database.db.close();
      const Sqlite = require("better-sqlite3");
      database.db = new Sqlite(path.join(directory, "transcriptions.db"));
      const saved = database.getNote(note.id);
      assert.equal(saved.enhanced_content, EDITED);
      assert.equal(saved.content, CONTENT);
      assert.equal(saved.transcript, TRANSCRIPT);
      assert.equal(saved.title, "Workshop");
      assert.deepEqual(result.data.updatedFields, ["summary"]);
    }
  );
  await t.test("rename with unrelated blank fields preserves both documents", async () => {
    const before = database.getNote(note.id);
    const result = await updateNoteTool.execute({
      id: note.id,
      title: "Renamed",
      content: "",
      summary: "",
    });
    assert.equal(result.success, true);
    assert.equal(database.getNote(note.id).content, before.content);
    assert.equal(database.getNote(note.id).enhanced_content, before.enhanced_content);
  });
  await t.test("explicit empty summary and content clear only the chosen field", async () => {
    assert.equal(
      (await updateNoteTool.execute({ id: note.id, clear_fields: ["summary"] })).success,
      true
    );
    assert.equal(database.getNote(note.id).enhanced_content, "");
    assert.equal(database.getNote(note.id).content, CONTENT);
    assert.equal(
      (await updateNoteTool.execute({ id: note.id, clear_fields: ["content"] })).success,
      true
    );
    assert.equal(database.getNote(note.id).content, "");
    database.updateNote(note.id, { content: CONTENT, enhanced_content: SUMMARY });
  });
  await t.test("a rejected save does not claim an update or schedule sync", async () => {
    const before = pushes.length;
    const stub = t.mock.method(globalThis.window.electronAPI, "updateNote", async () => ({
      success: false,
    }));
    const result = await updateNoteTool.execute({ id: note.id, summary: EDITED });
    stub.mock.restore();
    assert.equal(result.success, false);
    assert.match(result.displayText, /Failed to update note/);
    assert.equal(pushes.length, before);
    assert.equal(database.getNote(note.id).enhanced_content, SUMMARY);
  });
  await t.test("cancellation while reading the note prevents the pending write", async () => {
    const controller = new AbortController();
    const stub = t.mock.method(globalThis.window.electronAPI, "getNote", async (id) => {
      controller.abort();
      return database.getNote(id);
    });
    const result = await updateNoteTool.execute(
      { id: note.id, content: "Must not save" },
      { signal: controller.signal }
    );
    stub.mock.restore();
    assert.equal(result.success, false);
    assert.equal(database.getNote(note.id).content, CONTENT);
  });
});
