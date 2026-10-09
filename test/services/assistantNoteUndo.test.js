const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// Real SQLite and the real tool/registry, with only Electron/provider transport stubbed.
test("safe assistant edits and atomic Undo", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ow-assistant-undo-"));
  const originalLoad = Module._load;
  let database;
  try {
    Module._load = function (request, parent, isMain) {
      if (request === "electron")
        return {
          app: { getPath: () => directory, getAppPath: () => process.cwd(), isReady: () => false },
        };
      return originalLoad.call(this, request, parent, isMain);
    };
    const DatabaseManager = require("../../src/helpers/database.js");
    database = new DatabaseManager();
  } finally {
    Module._load = originalLoad;
  }
  t.after(() => {
    database.db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        getNote: async (id) => database.getNote(id),
        updateNote: async (id, updates, options) => database.updateNote(id, updates, options),
        getFolders: async (spaceId) => database.getFolders(spaceId),
        createFolder: async (name, spaceId) => database.createFolder(name, spaceId),
      },
    },
  });
  const vite = await createRendererServer(t);
  const { syncService } = await vite.ssrLoadModule("/services/SyncService.ts");
  const pushes = [];
  t.mock.method(syncService, "debouncedPush", (...args) => pushes.push(args));
  const { updateNoteTool } = await vite.ssrLoadModule("/services/tools/updateNoteTool.ts");
  const { executeTool } = await vite.ssrLoadModule("/services/tools/ToolRegistry.ts");
  const fresh = () => {
    const note = database.saveNote("Workshop", "Private notes", "meeting").note;
    database.updateNote(note.id, {
      enhanced_content: "## Decisions\nKeep it\n\n## Next\nDo it",
      transcript: "Source",
      enhancement_prompt: "Prompt",
      enhanced_at_content_hash: "hash",
    });
    return database.getNote(note.id);
  };
  const tokenFor = (id) => database.getNoteUndos().find((edit) => edit.noteId === id)?.token;
  const edit = (note, updates) => updateNoteTool.execute({ id: note.id, ...updates });

  for (const operation of ["rename", "move"])
    await t.test(
      `${operation} with extraneous blanks preserves documents and metadata`,
      async () => {
        const note = fresh();
        const folder = database.createFolder(`Folder ${note.id}`, note.space_id).folder;
        const result = await edit(note, {
          ...(operation === "rename" ? { title: "Renamed" } : { folder: folder.name }),
          content: "",
          summary: " \n ",
        });
        assert.equal(result.success, true);
        assert.deepEqual(result.data.ignoredFields, ["content", "summary"]);
        const saved = database.getNote(note.id);
        for (const key of [
          "content",
          "enhanced_content",
          "transcript",
          "enhancement_prompt",
          "enhanced_at_content_hash",
        ])
          assert.equal(saved[key], note[key]);
        assert.equal(
          saved[operation === "rename" ? "title" : "folder_id"],
          operation === "rename" ? "Renamed" : folder.id
        );
        assert.equal(database.undoNoteUpdate(tokenFor(note.id)).success, true);
        assert.equal(database.getNote(note.id).folder_id, note.folder_id);
        assert.equal(database.getNote(note.id).title, note.title);
      }
    );

  await t.test(
    "omitted/null fields are absent, wrong types fail, unmarked blanks never clear",
    async () => {
      const note = fresh();
      assert.equal(
        (await edit(note, { title: "Renamed", content: null, summary: null })).success,
        true
      );
      assert.equal(database.getNote(note.id).enhanced_content, note.enhanced_content);
      const token = tokenFor(note.id);
      for (const fields of [
        { content: 3 },
        { summary: false },
        { title: {} },
        { folder: [] },
        { clear_fields: "summary" },
        { clear_fields: ["transcript"] },
        { summary: "replacement", clear_fields: ["summary"] },
        { summary: "" },
        {},
      ]) {
        assert.equal((await edit(note, fields)).success, false, JSON.stringify(fields));
        assert.equal(tokenFor(note.id), token);
        assert.equal(database.getNote(note.id).content, note.content);
        assert.equal(database.getNote(note.id).enhanced_content, note.enhanced_content);
      }
    }
  );

  for (const field of ["content", "summary"])
    await t.test(`explicit ${field} clearing and reopen/Undo`, async () => {
      const note = fresh();
      const result = await edit(note, { clear_fields: [field] });
      assert.equal(result.success, true);
      assert.deepEqual(result.data.updatedFields, [field]);
      const key = field === "summary" ? "enhanced_content" : field;
      assert.equal(database.getNote(note.id)[key], "");
      database.db.close();
      database.db = new (require("better-sqlite3"))(path.join(directory, "transcriptions.db"));
      assert.equal(database.getNote(note.id)[key], "");
      assert.equal(database.undoNoteUpdate(tokenFor(note.id)).success, true);
      const restored = database.getNote(note.id);
      for (const key of [
        "title",
        "content",
        "enhanced_content",
        "transcript",
        "enhancement_prompt",
        "enhanced_at_content_hash",
      ])
        assert.equal(restored[key], note[key]);
      assert.equal(tokenFor(note.id), undefined);
    });

  await t.test(
    "partial section removal and successive edits undo only the latest change",
    async () => {
      const note = fresh();
      await edit(note, { summary: "## Next\nDo it" });
      const first = tokenFor(note.id);
      await edit(note, { title: "Renamed" });
      const second = tokenFor(note.id);
      assert.notEqual(second, first);
      assert.equal(database.undoNoteUpdate(first).success, false);
      assert.equal(database.undoNoteUpdate(second).success, true);
      assert.equal(database.getNote(note.id).title, note.title);
      assert.equal(database.getNote(note.id).enhanced_content, "## Next\nDo it");
      assert.equal(database.getNote(note.id).content, note.content);
    }
  );

  await t.test("failed save rolls back and cannot create recovery or sync", async () => {
    const note = fresh();
    const before = pushes.length;
    const stub = t.mock.method(database, "updateNote", () => ({ success: false }));
    const result = await edit(note, { title: "Failed" });
    stub.mock.restore();
    assert.equal(result.success, false);
    assert.equal(tokenFor(note.id), undefined);
    assert.equal(pushes.length, before);
    assert.equal(database.getNote(note.id).title, note.title);
  });

  await t.test(
    "late committed save remains undoable after registry cancellation and note switch",
    async () => {
      const note = fresh();
      const other = fresh();
      const controller = new AbortController();
      let release, started;
      const saving = new Promise((resolve) => {
        started = resolve;
      });
      const stub = t.mock.method(globalThis.window.electronAPI, "updateNote", async (...args) => {
        const result = database.updateNote(...args);
        started();
        await new Promise((resolve) => {
          release = resolve;
        });
        return result;
      });
      const pending = executeTool(
        updateNoteTool,
        { id: note.id, content: "Assistant replacement" },
        { signal: controller.signal }
      );
      await saving;
      controller.abort();
      assert.equal((await pending).success, false);
      assert.equal(database.getNote(other.id).content, other.content);
      assert.equal(database.undoNoteUpdate(tokenFor(note.id)).success, true);
      release();
      await new Promise((resolve) => setImmediate(resolve));
      stub.mock.restore();
      assert.equal(database.getNote(note.id).content, note.content);
    }
  );

  for (const change of [
    "manual",
    "edit and revert",
    "cloud",
    "deleted",
    "hard deleted",
    "identity",
    "dirty draft",
  ])
    await t.test(`${change} prevents a stale Undo`, async () => {
      const note = fresh();
      await edit(note, { content: "Assistant replacement" });
      const token = tokenFor(note.id);
      if (change === "manual") database.updateNote(note.id, { title: "Manual title" });
      if (change === "edit and revert") {
        database.updateNote(note.id, { content: "Manual edit" });
        database.updateNote(note.id, { content: "Assistant replacement" });
      }
      if (change === "cloud")
        database.db.prepare("UPDATE notes SET content = 'Remote edit' WHERE id = ?").run(note.id);
      if (change === "deleted") database.updateNote(note.id, { deleted_at: "2026-10-09" });
      if (change === "hard deleted")
        database.db.prepare("DELETE FROM notes WHERE id = ?").run(note.id);
      if (change === "identity")
        database.updateNote(note.id, { client_note_id: "replacement-identity" });
      if (change === "dirty draft") database.discardNoteUndo(note.id);
      const before = database.getNote(note.id);
      assert.equal(database.undoNoteUpdate(token).success, false);
      assert.deepEqual(database.getNote(note.id), before);
    });

  await t.test(
    "sync acknowledgement preserves Undo and unrelated notes have independent tokens",
    async () => {
      const one = fresh(),
        two = fresh();
      await edit(one, { title: "One" });
      const token = tokenFor(one.id);
      await edit(two, { title: "Two" });
      database.updateNote(one.id, { sync_status: "synced", cloud_updated_at: "2026-10-09" });
      assert.equal(database.undoNoteUpdate(token).success, true);
      assert.equal(database.getNote(two.id).title, "Two");
      assert.ok(tokenFor(two.id));
    }
  );

  await t.test("first cloud create acknowledgement keeps recovery", async () => {
    const note = fresh();
    await edit(note, { title: "Synced edit" });
    const token = tokenFor(note.id);
    const snapshot = database.getNote(note.id);
    const ack = database.acknowledgeNoteCreate(
      note.id,
      snapshot,
      `cloud-${note.id}`,
      "2026-10-09",
      "owner-one"
    );
    assert.equal(ack.outcome, "synced");
    assert.equal(tokenFor(note.id), token);
    assert.equal(database.undoNoteUpdate(token).success, true);
    assert.equal(database.getNote(note.id).title, note.title);
  });

  await t.test("journal failure rolls back the edit; failed Undo retains recovery", async () => {
    const note = fresh();
    database.db.exec(
      "CREATE TEMP TRIGGER fail_undo_journal BEFORE INSERT ON assistant_note_undo BEGIN SELECT RAISE(ABORT, 'disk full'); END"
    );
    assert.equal((await edit(note, { title: "Must roll back" })).success, false);
    database.db.exec("DROP TRIGGER fail_undo_journal");
    assert.equal(database.getNote(note.id).title, note.title);
    assert.equal(tokenFor(note.id), undefined);
    await edit(note, { title: "Recoverable" });
    const token = tokenFor(note.id);
    const failure = t.mock.method(database, "updateNote", () => ({
      success: false,
      error: "disk full",
    }));
    assert.equal(database.undoNoteUpdate(token).success, false);
    failure.mock.restore();
    assert.equal(tokenFor(note.id), token);
    assert.equal(database.getNote(note.id).title, "Recoverable");
  });

  await t.test("real account scope hides and refuses another account's recovery", async () => {
    database.setActiveAccountId("account-one");
    const note = fresh();
    await edit(note, { title: "Account one edit" });
    const token = tokenFor(note.id);
    assert.ok(token);
    database.setActiveAccountId("account-two");
    assert.equal(database.getNote(note.id), null);
    assert.equal(tokenFor(note.id), undefined);
    assert.equal(database.undoNoteUpdate(token).success, false);
    database.setActiveAccountId("account-one");
    assert.equal(database.undoNoteUpdate(token).success, true);
    database.setActiveAccountId(null);
  });

  await t.test(
    "recovery remains bound to the originating account even for a shared local note",
    async () => {
      database.setActiveAccountId(null);
      const note = fresh();
      await edit(note, { title: "Signed-out edit" });
      const token = tokenFor(note.id);
      database.setActiveAccountId("another-account");
      assert.ok(database.getNote(note.id), "legacy local note remains readable by design");
      assert.equal(tokenFor(note.id), undefined);
      assert.equal(database.undoNoteUpdate(token).success, false);
      database.setActiveAccountId(null);
      assert.equal(database.undoNoteUpdate(token).success, true);
      assert.equal(database.getNote(note.id).title, note.title);
    }
  );

  await t.test("concurrent changes before commit fail truthfully", async () => {
    const note = fresh();
    const stub = t.mock.method(
      globalThis.window.electronAPI,
      "updateNote",
      async (id, updates, options) => {
        database.updateNote(id, { content: "Concurrent edit" });
        return database.updateNote(id, updates, options);
      }
    );
    const result = await edit(note, { summary: "New summary" });
    stub.mock.restore();
    assert.equal(result.success, false);
    assert.match(result.displayText, /Note changed/);
    assert.equal(database.getNote(note.id).content, "Concurrent edit");
    assert.equal(database.getNote(note.id).enhanced_content, note.enhanced_content);
    assert.equal(tokenFor(note.id), undefined);
  });

  await t.test("deleted previous folder and account switch cannot restore", async () => {
    const note = fresh();
    const folder = database.createFolder(`Original ${note.id}`, note.space_id).folder;
    database.updateNote(note.id, { folder_id: folder.id });
    await edit(note, { folder: `New ${note.id}` });
    const token = tokenFor(note.id);
    database.db.prepare("UPDATE folders SET deleted_at = '2026-10-09' WHERE id = ?").run(folder.id);
    assert.equal(database.undoNoteUpdate(token).success, false);
    const accountNote = fresh();
    await edit(accountNote, { title: "Changed" });
    const accountToken = tokenFor(accountNote.id);
    const scoped = t.mock.method(database, "getNote", () => null);
    assert.equal(database.undoNoteUpdate(accountToken).success, false);
    scoped.mock.restore();
    assert.equal(database.getNote(accountNote.id).title, "Changed");
  });
});
