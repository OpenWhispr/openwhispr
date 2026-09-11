const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { MeetingAudioStorage, validateSettings } = require("../../src/helpers/meetingAudioStorage");
const { createAudioHandler, rangeFor } = require("../../src/helpers/meetingAudioProtocol");
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ow-retain-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return new MeetingAudioStorage(root);
}
test("both source tracks survive restart as playable WAV with exact samples", async (t) => {
  const store = fixture(t);
  store.start(42);
  const pcm = Buffer.alloc(48000, 12);
  store.append("mic", pcm, 1000);
  store.append("system", pcm, 1500);
  await store.stop();
  const restarted = new MeetingAudioStorage(store.root);
  const [record] = restarted.list(42);
  assert.equal(restarted.settings.retentionDays, 0);
  assert.equal(record.tracks.length, 2);
  const file = restarted.resolveTrack(42, record.id, "mic");
  const bytes = fs.readFileSync(file);
  assert.equal(bytes.readUInt32LE(40), 48000);
  assert.deepEqual(bytes.subarray(44), pcm);
  assert.equal(record.tracks[0].startedAt, 1000);
  assert.equal(record.tracks[0].durationSeconds, 1);
  assert.throws(() => restarted.resolveTrack(99, record.id, "mic"));
  assert.throws(() => restarted.resolveTrack(42, "../../escape", "mic"));
});
test("retention defaults forever and only explicit expiration removes recordings", async (t) => {
  const store = fixture(t);
  store.start(1);
  store.append("mic", Buffer.alloc(48));
  await store.stop();
  store.cleanup(Date.now() + 400 * 86400000);
  assert.equal(store.list(1).length, 1);
  store.setSettings({ keepOriginalAudio: true, retentionDays: 7 });
  store.cleanup(Date.now() + 8 * 86400000);
  assert.equal(store.list(1).length, 0);
  store.setSettings({ keepOriginalAudio: false, retentionDays: 0 });
  store.start(1);
  store.append("mic", Buffer.alloc(48));
  await store.stop();
  assert.equal(store.list(1).length, 0);
  assert.throws(() => validateSettings({ keepOriginalAudio: true, retentionDays: -1 }));
});
test("media protocol serves seek ranges and rejects cross-note access", async (t) => {
  const store = fixture(t);
  store.start(42);
  store.append("mic", Buffer.alloc(480, 7));
  await store.stop();
  const id = store.list(42)[0].id;
  const handler = createAudioHandler(
    () => store,
    (id) => id === 42
  );
  const url = "meeting-audio://recording/42/" + id + "/mic";
  const response = await handler(new Request(url, { headers: { range: "bytes=44-53" } }));
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("content-range"), "bytes 44-53/524");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.alloc(10, 7));
  assert.equal((await handler(new Request(url.replace("/42/", "/99/")))).status, 404);
  assert.equal(rangeFor("bytes=600-", 524), null);
  assert.deepEqual(rangeFor("bytes=-10", 524), { start: 514, end: 523, partial: true });
});
