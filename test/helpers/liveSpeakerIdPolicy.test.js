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

// The sole production call site passes only the mode, so the defaulted platform
// is the path that actually ships. Asserting it against process.platform would
// compare the function to itself and pass on CI (Linux) even if the default were
// deleted, so stub the platform instead.
test("platform defaults to the current process platform", async () => {
  const { supportsLiveSpeakerIdentification } = await load();
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");

  const onPlatform = (platform, run) => {
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
    try {
      run();
    } finally {
      Object.defineProperty(process, "platform", originalPlatform);
    }
  };

  onPlatform("win32", () => {
    assert.equal(supportsLiveSpeakerIdentification("loopback"), true);
    assert.equal(supportsLiveSpeakerIdentification("native"), true);
  });
  onPlatform("linux", () => {
    assert.equal(supportsLiveSpeakerIdentification("loopback"), false);
    assert.equal(supportsLiveSpeakerIdentification("native"), true);
  });
  onPlatform("darwin", () => {
    assert.equal(supportsLiveSpeakerIdentification("loopback"), false);
  });
});
