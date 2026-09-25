const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/systemAudioSource.js");

test("today's capture of every playback device is the default", async () => {
  const { DEFAULT_SYSTEM_AUDIO_SOURCE, SYSTEM_AUDIO_SOURCES } = await load();

  assert.equal(DEFAULT_SYSTEM_AUDIO_SOURCE, "all-devices");
  assert.deepEqual(SYSTEM_AUDIO_SOURCES, ["all-devices", "default-device"]);
});

test("each known source is kept as it is", async () => {
  const { normalizeSystemAudioSource } = await load();

  assert.equal(normalizeSystemAudioSource("all-devices"), "all-devices");
  assert.equal(normalizeSystemAudioSource("default-device"), "default-device");
});

test("anything unrecognised means all playback devices", async () => {
  const { normalizeSystemAudioSource } = await load();

  // A value synced raw from another window, one written by a newer build, or
  // a missing IPC field must never opt a user out of today's capture.
  for (const value of [undefined, null, "", "Default-Device", "specific-device", 1, {}]) {
    assert.equal(normalizeSystemAudioSource(value), "all-devices", String(value));
  }
});
