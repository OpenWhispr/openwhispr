// Transcription half of SyncService over a real DatabaseManager, with only the
// HTTP boundary faked. A failed entry can keep the transcript a later step
// could not process (#2676); it stays on this device until a retry completes
// it, so other devices and the server never hold a failed copy that a retry
// here would leave behind; the next sync pass pushes the completed row.

const test = require("node:test");
const assert = require("node:assert/strict");

const { createDb } = require("./harness/db.js");
const {
  installBrowserGlobals,
  resetBrowserGlobals,
  enableSync,
  establishValidatedAuth,
  stopSyncTimers,
  window: windowStub,
} = require("./harness/browserGlobals.js");
const { createElectronApi } = require("./harness/electronApiBridge.js");
const { createFakeCloud } = require("./harness/fakeCloud.js");
const { SyncService } = require("../../src/services/SyncService.ts");

async function setup(t) {
  const db = createDb(t);
  if (!db) return null;
  resetBrowserGlobals();
  installBrowserGlobals();
  enableSync();
  const cloud = createFakeCloud();
  windowStub.electronAPI = createElectronApi(db, { cloud });
  await establishValidatedAuth();
  const service = new SyncService();
  t.after(() => stopSyncTimers(service));
  return { db, cloud, service };
}

const pushedTexts = (cloud) => [
  ...cloud.logFor("/api/transcriptions/create").map((call) => [call.body.text, call.body.status]),
  ...cloud
    .logFor("/api/transcriptions/batch-create")
    .flatMap((call) => call.body.transcriptions.map((row) => [row.text, row.status])),
];

test("a failed entry with a kept transcript syncs only once a retry completes it", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, service } = ctx;

  const { id } = db.saveTranscription("kept text", "kept text", {
    status: "failed",
    errorMessage: "Selection edit failed",
    errorCode: "SELECTION_EDIT_CAPTURE_FAILED",
    clientTranscriptionId: "cloud-client-id",
  });
  db.saveTranscription("done", "done");

  await service.pushEntity("transcription", id);
  await service.syncAll(true);
  assert.deepEqual(pushedTexts(cloud), [["done", "completed"]]);
  assert.equal(db.getTranscriptionById(id).cloud_id, null);

  // Retry overwrites the text and completes the row; the next sync pushes it.
  db.updateTranscriptionText(id, "retried text", "retried text");
  db.updateTranscriptionStatus(id, "completed");
  await service.syncAll(true);

  const retried = cloud
    .logFor("/api/transcriptions/batch-create")
    .flatMap((call) => call.body.transcriptions)
    .filter((row) => row.client_transcription_id === "cloud-client-id");
  assert.deepEqual(
    retried.map(({ text, status }) => [text, status]),
    [["retried text", "completed"]]
  );
  assert.ok(db.getTranscriptionById(id).cloud_id);
});
