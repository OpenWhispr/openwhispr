const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/liveSpeakerIdPolicy.js");

test("native system audio (macOS tap) supports live speaker identification", async () => {
  const { supportsLiveSpeakerIdentification } = await load();

  for (const platform of ["darwin", "win32", "linux"]) {
    assert.equal(supportsLiveSpeakerIdentification("native", platform), true);
  }
});

test("Windows loopback supports live speaker identification", async () => {
  const { supportsLiveSpeakerIdentification } = await load();

  // Both Windows strategies (WASAPI helper and renderer display-media
  // fallback) report mode "loopback" and feed the same 24 kHz mono s16le
  // sendMeetingAudio path as the macOS native tap.
  assert.equal(supportsLiveSpeakerIdentification("loopback", "win32"), true);
});

test("Linux loopback (PipeWire portal) stays disabled until verified", async () => {
  const { supportsLiveSpeakerIdentification } = await load();

  assert.equal(supportsLiveSpeakerIdentification("loopback", "linux"), false);
});

test("unsupported mode never identifies speakers", async () => {
  const { supportsLiveSpeakerIdentification } = await load();

  for (const platform of ["darwin", "win32", "linux"]) {
    assert.equal(supportsLiveSpeakerIdentification("unsupported", platform), false);
  }
});

test("missing mode never identifies speakers", async () => {
  const { supportsLiveSpeakerIdentification } = await load();

  assert.equal(supportsLiveSpeakerIdentification(undefined, "win32"), false);
  assert.equal(supportsLiveSpeakerIdentification(null, "darwin"), false);
});

test("platform defaults to the current process platform", async () => {
  const { supportsLiveSpeakerIdentification } = await load();

  assert.equal(
    supportsLiveSpeakerIdentification("loopback"),
    supportsLiveSpeakerIdentification("loopback", process.platform)
  );
});
