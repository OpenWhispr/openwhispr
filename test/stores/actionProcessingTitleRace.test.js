const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const ACTION = {
  id: 1,
  name: "Generate Notes",
  prompt: "Summarize the meeting.",
  client_id: "generateNotes",
};
const LABELS = { noModel: "no model", noEndpoint: "no endpoint", actionFailed: "failed" };

async function loadRun(t, { renameAtWrite = false, initialTitle = "Untitled Note" } = {}) {
  const { createDb } = require("../helpers/harness/db.js");
  const db = createDb(t);
  assert.ok(db);
  db.setActiveAccountId("test-account");
  const persisted = db.saveNote(initialTitle, "Meeting notes", "personal").note;
  const titleStarted = Promise.withResolvers();
  const titleReply = Promise.withResolvers();
  const saved = Promise.withResolvers();
  const note = persisted;
  const calls = [];
  globalThis.__titleRaceProcess = async (text, model, agent, config) => {
    calls.push({ text, model, config });
    if (calls.length === 1) return "# Notes\n- Ship Friday.";
    titleStarted.resolve();
    return titleReply.promise;
  };
  t.after(() => delete globalThis.__titleRaceProcess);
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        getNote: async () => db.getNote(note.id),
        updateNote: async (id, payload, options) => {
          if (renameAtWrite) db.updateNote(id, { title: "Customer Alpha handoff" });
          const result = db.updateNote(id, payload, options);
          Object.assign(note, db.getNote(id));
          saved.resolve(payload);
          return result;
        },
      },
    },
  });
  const vite = await createRendererServer(t, {
    mockModules: {
      "/services/ReasoningService": `export default {
        processText: (...args) => globalThis.__titleRaceProcess(...args),
      };`,
    },
  });
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  useSettingsStore.setState({ autoGenerateNoteTitle: true });
  const store = await vite.ssrLoadModule("/stores/actionProcessingStore.ts");
  t.after(() => store.cancelAction(note.id));
  store.runBackgroundAction(
    note.id,
    "Meeting notes",
    "hash",
    ACTION,
    {
      modelId: "gpt-4.1",
      isCloudMode: true,
      allowTitleGeneration: true,
      titleGeneration: { expectedTitle: initialTitle },
    },
    LABELS
  );
  await titleStarted.promise;
  return { note, saved, titleReply, store, db };
}

test("a title saved by the user while Generate Notes runs survives its generated title", async (t) => {
  const { note, saved, titleReply, store, db } = await loadRun(t);
  db.updateNote(note.id, { title: "Customer Alpha handoff" });
  titleReply.resolve("Release Schedule");
  await saved.promise;
  await new Promise(setImmediate);

  assert.equal(note.enhanced_content, "# Notes\n- Ship Friday.");
  assert.equal(note.title, "Customer Alpha handoff");
  const [applied] = store.consumeAppliedEvents();
  assert.equal(applied.previous.title, undefined, "summary Undo must not rename the note");
});

test("Generate Notes still names an untouched placeholder and includes it in Undo", async (t) => {
  const { note, saved, titleReply, store } = await loadRun(t);
  titleReply.resolve("Release Schedule");
  await saved.promise;
  await new Promise(setImmediate);

  assert.equal(note.enhanced_content, "# Notes\n- Ship Friday.");
  assert.equal(note.title, "Release Schedule");
  const [applied] = store.consumeAppliedEvents();
  assert.equal(applied.previous.title, "Untitled Note");
});

test("a rename between the renderer snapshot and the write survives generated naming", async (t) => {
  const { note, saved, titleReply, store } = await loadRun(t, { renameAtWrite: true });
  titleReply.resolve("Release Schedule");
  await saved.promise;
  await new Promise(setImmediate);
  assert.equal(note.title, "Customer Alpha handoff");
  assert.equal(note.enhanced_content, "# Notes\n- Ship Friday.");
  assert.equal(store.consumeAppliedEvents()[0].previous.title, undefined);
});

test("an unchanged calendar title accepts generated naming and title Undo", async (t) => {
  const { note, saved, titleReply, store } = await loadRun(t, { initialTitle: "Weekly planning" });
  titleReply.resolve("Release Schedule");
  await saved.promise;
  await new Promise(setImmediate);
  assert.equal(note.title, "Release Schedule");
  assert.equal(store.consumeAppliedEvents()[0].previous.title, "Weekly planning");
});
