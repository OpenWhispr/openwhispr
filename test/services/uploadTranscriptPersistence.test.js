const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createDb } = require("../helpers/harness/db");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

for (const source of ["file", "url"]) {
  for (const timed of [false, true]) {
    test(`${source} upload stores ${timed ? "timed" : "text-only"} transcription separately at creation`, async (t) => {
      const db = createDb(t);
      assert.ok(db);
      const handwritten = db.saveNote("My notes", "Keep my handwritten notes").note;
      const meeting = db.saveNote("Existing meeting", "Meeting notes", "meeting").note;
      db.updateNote(meeting.id, { transcript: "Existing transcript", enhanced_content: "Summary" });
      const originals = [db.getNote(handwritten.id), db.getNote(meeting.id)];
      const text = "Public synthetic transcript.\nSecond paragraph.";
      const segments = timed ? [{ text, start: 2, end: 5, speaker: "Speaker 1" }] : undefined;
      const created = [];
      const { window } = installBrowserGlobals(t);
      Object.assign(window.electronAPI, {
        transcribeAudioFile: async () => ({ success: true, text, segments, durationSeconds: 12 }),
        downloadUrlAudio: async () => ({
          success: true,
          tempPath: "/synthetic/file.wav",
          title: "Public title",
          sizeBytes: 100,
        }),
        onUrlDownloadProgress: () => () => {},
        saveNote: async (...args) => {
          const result = db.saveNote(...args);
          created.push(result.note);
          return result;
        },
        // Metadata failure must never lose the already-created transcript.
        updateNote: async () => {
          throw new Error("metadata unavailable");
        },
        deleteTempFile: () => {},
      });
      const vite = await createRendererServer(t, {
        mockModules: {
          "/lib/auth": "export const withSessionRefresh = (fn) => fn();",
          "./settingsStore": "export const getSettings = () => ({});",
          "./policyStore": "export const usePolicyStore = { getState: () => ({}) };",
          "./policyRules": "export const isTranscriptionContextAllowed = () => true;",
        },
      });
      const queue = await vite.ssrLoadModule("/stores/batchQueueStore.ts");
      if (source === "file")
        queue.addFiles([{ name: "fixture.wav", path: "/synthetic/file.wav", sizeBytes: 100 }]);
      else queue.addUrls(["https://www.youtube.com/watch?v=public123"]);
      queue.processBatchQueue(
        {
          transcription: {
            useLocalWhisper: true,
            localTranscriptionProvider: "whisper",
            whisperModel: "base",
            parakeetModel: "unused",
            isOpenWhisprCloud: false,
            getApiKey: () => "",
            cloudTranscriptionProvider: "openai",
            cloudTranscriptionBaseUrl: "",
            cloudTranscriptionModel: "whisper-1",
            language: "en",
          },
          folderId: null,
          generateTitle: async () => "Generated title",
        },
        { enabled: timed, localModelsReady: false, numSpeakers: null }
      );
      const deadline = Date.now() + 5000;
      while (queue.useBatchQueueStore.getState().isProcessing && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const item = queue.useBatchQueueStore.getState().queue[0];
      assert.equal(item.status, "done");
      const note = db.getNote(item.noteId);
      assert.equal(note.content, "");
      assert.equal(
        created[0].transcript,
        note.transcript,
        "initial note-added/mirror snapshot includes transcript"
      );
      assert.deepEqual(
        JSON.parse(note.transcript).map((segment) => segment.text),
        [text]
      );
      assert.equal(JSON.parse(note.transcript)[0].speaker, timed ? "speaker_0" : undefined);
      assert.equal(typeof JSON.parse(note.transcript)[0].timestamp, timed ? "number" : "undefined");
      assert.equal(note.note_type, "upload");
      assert.equal(note.title, source === "file" ? "Generated title" : "Public title");
      assert.equal(note.source_file, source === "file" ? "fixture.wav" : "Public title");
      assert.deepEqual([db.getNote(handwritten.id), db.getNote(meeting.id)], originals);
      const filename = db.db.name;
      db.db.close();
      db.db = new (require("better-sqlite3"))(filename);
      assert.equal(db.getNote(note.id).transcript, note.transcript);
      const mirror = require("../../src/helpers/markdownMirror");
      const mirrorPath = path.join(path.dirname(filename), "mirror");
      mirror.init(mirrorPath);
      mirror.writeNote(note, "Personal");
      mirror.writeTranscript(note, "Personal", {});
      const transcriptPath = fs
        .readdirSync(path.join(mirrorPath, "Personal"))
        .find((name) => name.endsWith("-transcript.md"));
      assert.ok(transcriptPath);
      assert.ok(
        fs.readFileSync(path.join(mirrorPath, "Personal", transcriptPath), "utf8").includes(text)
      );
    });
  }
}

test("upload transcript crosses the actual preload and save IPC handler before broadcasting", async (t) => {
  const db = createDb(t);
  assert.ok(db);
  const vm = require("node:vm");
  const ts = require("typescript");
  const source = ts.createSourceFile(
    "ipcHandlers.js",
    fs.readFileSync("src/helpers/ipcHandlers.js", "utf8"),
    ts.ScriptTarget.Latest,
    true
  );
  let callback;
  function visit(node) {
    if (ts.isCallExpression(node) && node.arguments[0]?.text === "db-save-note") {
      callback = node.arguments[1].getText(source);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(callback);
  const broadcasts = [];
  const mirrored = [];
  const owner = {
    databaseManager: db,
    notifyVectorChanges() {},
    _asyncMirrorWrite: (note) => mirrored.push(note),
  };
  const handler = vm.runInNewContext(`(function () { return (${callback}); }).call(owner)`, {
    owner,
    setImmediate: (fn) => fn(),
    broadcastToWindows: (...args) => broadcasts.push(args),
  });
  const { window } = installBrowserGlobals(t);
  vm.runInNewContext(fs.readFileSync("preload.js", "utf8"), {
    process,
    require: (name) => {
      assert.equal(name, "electron");
      return {
        contextBridge: {
          exposeInMainWorld: (_name, api) => {
            window.electronAPI = api;
          },
        },
        webUtils: {},
        ipcRenderer: {
          invoke: async (channel, ...args) => {
            assert.equal(channel, "db-save-note");
            return handler.call(owner, {}, ...args);
          },
          on() {},
          removeListener() {},
          send() {},
          sendSync() {},
        },
      };
    },
  });
  const { saveUploadNote } = await import("../../src/services/uploadNotes.ts");
  const saved = await saveUploadNote({
    title: "Atomic upload",
    text: "Public fixture words",
    sourceName: "fixture.wav",
    folderId: null,
    diarization: { enabled: false, localModelsReady: false, numSpeakers: null },
  });
  const stored = db.getNote(saved.note.id);
  assert.equal(stored.content, "");
  assert.deepEqual(JSON.parse(stored.transcript), [{ text: "Public fixture words" }]);
  assert.equal(broadcasts[0][0], "note-added");
  assert.equal(broadcasts[0][1].transcript, stored.transcript);
  assert.equal(mirrored[0].transcript, stored.transcript);
});

test("a segment without a start keeps the complete uploaded text without invented times", async (t) => {
  const db = createDb(t);
  assert.ok(db);
  const { window } = installBrowserGlobals(t);
  window.electronAPI.saveNote = async (...args) => db.saveNote(...args);
  const { saveUploadNote } = await import("../../src/services/uploadNotes.ts");
  const text = "First sentence. Second sentence.";
  const saved = await saveUploadNote({
    title: "Full result",
    text,
    sourceName: "fixture.wav",
    folderId: null,
    segments: [
      { text: "First sentence.", start: 0 },
      { text: "Second sentence.", start: NaN },
    ],
    diarization: { enabled: false, localModelsReady: false, numSpeakers: null },
  });
  assert.equal(saved.note.content, "");
  assert.deepEqual(JSON.parse(db.getNote(saved.note.id).transcript), [{ text }]);
});

// The provider's text is formatted for reading (speaker headers) or joined
// without spaces (CJK), so it never equals the segments' text; the segments
// still hold the words, and their timing and speakers must survive.
for (const { name, text, segments, speakers } of [
  {
    name: "a provider-diarized upload keeps its speakers and times",
    text: "[A] 00:00 - 00:02\nhello there\n\n[B] 00:02 - 00:04\nhi back",
    segments: [
      { speaker: "A", text: "hello there", start: 0, end: 2 },
      { speaker: "B", text: "hi back", start: 2, end: 4 },
    ],
    speakers: ["speaker_0", "speaker_1"],
  },
  {
    name: "a CJK upload keeps its segment times",
    text: "你好。今天开会。",
    segments: [
      { text: "你好。", start: 0, end: 1 },
      { text: "今天开会。", start: 1, end: 2 },
    ],
    speakers: [undefined, undefined],
  },
]) {
  test(name, async (t) => {
    const db = createDb(t);
    assert.ok(db);
    const { window } = installBrowserGlobals(t);
    window.electronAPI.saveNote = async (...args) => db.saveNote(...args);
    const { saveUploadNote } = await import("../../src/services/uploadNotes.ts");
    const saved = await saveUploadNote({
      title: "Timed",
      text,
      sourceName: "fixture.wav",
      folderId: null,
      segments,
      diarization: { enabled: false, localModelsReady: false, numSpeakers: null },
    });
    const stored = JSON.parse(db.getNote(saved.note.id).transcript);
    assert.deepEqual(
      stored.map((segment) => segment.text),
      segments.map((segment) => segment.text)
    );
    assert.deepEqual(
      stored.map((segment) => segment.speaker),
      speakers
    );
    assert.equal(
      stored[1].timestamp - stored[0].timestamp,
      (segments[1].start - segments[0].start) * 1000
    );
  });
}

test("upload creation keeps its selected workspace and sends transcript in the real cloud payload", async (t) => {
  const db = createDb(t);
  assert.ok(db);
  db.setActiveAccountId("synthetic-account");
  const space = db.db
    .prepare(
      "INSERT INTO spaces (client_space_id, kind, name, sort_order) VALUES (?, 'team', ?, 1)"
    )
    .run("synthetic-space", "Target workspace");
  const spaceId = Number(space.lastInsertRowid);
  db.db
    .prepare("INSERT INTO space_accounts (space_id, account_id) VALUES (?, ?)")
    .run(spaceId, "synthetic-account");
  const folder = db.createFolder("Target folder", spaceId).folder;
  assert.ok(folder);
  const calls = [];
  const { window } = installBrowserGlobals(t);
  Object.assign(window.electronAPI, {
    saveNote: async (...args) => db.saveNote(...args),
    cloudApiRequest: async (request) => {
      assert.equal(request.path, "/api/notes/create");
      calls.push(JSON.parse(JSON.stringify(request)));
      return {
        success: true,
        data: {
          ...request.body,
          id: "synthetic-cloud-note",
          updated_at: "2026-10-22T00:00:00Z",
          user_id: "synthetic-account",
          row_created: true,
          write_applied: true,
        },
      };
    },
    acknowledgeNoteCreate: async (...args) => db.acknowledgeNoteCreate(...args),
    getNote: async (id) => db.getNote(id),
  });
  const vite = await createRendererServer(t);
  const { saveUploadNote } = await vite.ssrLoadModule("/services/uploadNotes.ts");
  const text = "Full uploaded words for cloud backup.";
  const saved = await saveUploadNote({
    title: "Scoped upload",
    text,
    sourceName: "fixture.wav",
    folderId: folder.id,
    diarization: { enabled: false, localModelsReady: false, numSpeakers: null },
  });
  const note = db.getNote(saved.note.id);
  assert.equal(note.folder_id, folder.id);
  assert.equal(note.space_id, spaceId);
  const { SyncService } = await vite.ssrLoadModule("/services/SyncService.ts");
  const service = new SyncService();
  await service.createCloudNote(note, "synthetic-cloud-folder", {
    space_id: "synthetic-cloud-space",
  });
  assert.equal(calls.length, 1);
  const { body } = calls[0];
  assert.equal(body.content, "");
  assert.equal(body.transcript, note.transcript);
  assert.deepEqual(JSON.parse(body.transcript), [{ text }]);
  assert.equal(body.folder_id, "synthetic-cloud-folder");
  assert.equal(body.space_id, "synthetic-cloud-space");
  const { buildNoteUpdatePayload } = await vite.ssrLoadModule("/helpers/cloudSyncGuards.js");
  const update = JSON.parse(
    JSON.stringify(buildNoteUpdatePayload({ ...note, cloud_revision: 3 }, "synthetic-cloud-folder"))
  );
  assert.equal(update.transcript, note.transcript);
});
