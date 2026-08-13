const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const values = new Map();
global.localStorage = {
  getItem: (key) => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, String(value)),
  removeItem: (key) => values.delete(key),
};

let loaded;
const load = () => {
  if (!loaded) {
    const filename = path.join(__dirname, "../../src/lib/noteConflictRegistry.ts");
    const source = fs.readFileSync(filename, "utf8");
    const output = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    loaded = import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
  }
  return loaded;
};

const cloudNote = {
  id: "cloud-note",
  client_note_id: "client-note",
  title: "Server title",
  content: "Server body",
  enhanced_content: null,
  note_type: "personal",
  enhancement_prompt: null,
  source_file: null,
  audio_duration_seconds: null,
  folder_id: null,
  transcript: null,
  enhanced_at_content_hash: null,
  participants: null,
  calendar_event_id: null,
  diarization_enabled: null,
  expected_speaker_count: null,
  workspace_id: null,
  space_id: null,
  updated_by_user_id: null,
  deleted_at: null,
  created_at: "2026-07-28T10:00:00.000Z",
  updated_at: "2026-07-28T10:01:00.000Z",
};

test.beforeEach(() => values.clear());

test("persists and restores the full conflict payload", async () => {
  const { addNoteConflict, readNoteConflictIds, readNoteConflicts, removeNoteConflictId } =
    await load();

  addNoteConflict("client-note", cloudNote);
  assert.deepEqual(readNoteConflicts(), { "client-note": cloudNote });
  assert.deepEqual([...readNoteConflictIds()], ["client-note"]);

  removeNoteConflictId("client-note");
  assert.deepEqual(readNoteConflicts(), {});
});

test("drops legacy id-only storage so a guarded push can re-surface it", async () => {
  const { readNoteConflictIds, readNoteConflicts } = await load();

  localStorage.setItem("noteConflicts.clientIds", JSON.stringify(["legacy-client"]));
  assert.deepEqual(readNoteConflicts(), {});
  assert.equal(localStorage.getItem("noteConflicts.clientIds"), null);
  assert.deepEqual([...readNoteConflictIds()], []);
});

test("account transition clears every persisted cloud conflict snapshot", async () => {
  const { addNoteConflict, clearNoteConflicts, readNoteConflicts } = await load();

  addNoteConflict("client-note", cloudNote);
  clearNoteConflicts();

  assert.deepEqual(readNoteConflicts(), {});
  assert.equal(localStorage.getItem("noteConflicts.clientIds"), null);
});
