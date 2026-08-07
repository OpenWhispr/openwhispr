const test = require("node:test");
const { mock } = require("node:test");
const assert = require("node:assert/strict");

const mediaPlayer = require("../../src/helpers/mediaPlayer");

function resetDuckState() {
  mediaPlayer._duckActive = false;
  mediaPlayer._duckOriginalVolume = null;
  mediaPlayer._volumeOpQueue = Promise.resolve();
}

test.beforeEach(() => {
  resetDuckState();
});

test.afterEach(() => {
  mock.restoreAll();
  resetDuckState();
});

test("duckSystem lowers volume and records the pre-duck level", async () => {
  const applyDuck = mock.method(mediaPlayer, "_applyDuck", async () => 80);

  assert.equal(await mediaPlayer.duckSystem(25), true);
  assert.equal(mediaPlayer._duckActive, true);
  assert.equal(mediaPlayer._duckOriginalVolume, 80);
  assert.equal(applyDuck.mock.callCount(), 1);
  assert.deepEqual(applyDuck.mock.calls[0].arguments, [25]);
});

test("duckSystem is a no-op while a duck is already active", async () => {
  const applyDuck = mock.method(mediaPlayer, "_applyDuck", async () => 80);

  await mediaPlayer.duckSystem(25);
  assert.equal(await mediaPlayer.duckSystem(25), true);

  // Re-snapshotting here would capture the already-ducked level as the original
  // and strand the user at 25% after restore.
  assert.equal(applyDuck.mock.callCount(), 1);
  assert.equal(mediaPlayer._duckOriginalVolume, 80);
});

test("duckSystem declines to duck when the volume cannot be read", async () => {
  mock.method(mediaPlayer, "_applyDuck", async () => null);

  assert.equal(await mediaPlayer.duckSystem(25), false);
  assert.equal(mediaPlayer._duckActive, false);
  assert.equal(mediaPlayer._duckOriginalVolume, null);
});

test("duckSystem does not latch when the volume is already at or below target", async () => {
  mock.method(mediaPlayer, "_applyDuck", async () => 10);

  assert.equal(await mediaPlayer.duckSystem(25), true);
  assert.equal(mediaPlayer._duckActive, false);
  assert.equal(mediaPlayer._duckOriginalVolume, null);
});

test("restoreSystemVolume puts the original level back and clears the latch", async () => {
  mock.method(mediaPlayer, "_applyDuck", async () => 80);
  const applyVolume = mock.method(mediaPlayer, "_applySystemVolume", async () => true);

  await mediaPlayer.duckSystem(25);
  assert.equal(await mediaPlayer.restoreSystemVolume(), true);

  assert.equal(applyVolume.mock.callCount(), 1);
  assert.deepEqual(applyVolume.mock.calls[0].arguments, [80]);
  assert.equal(mediaPlayer._duckActive, false);
  assert.equal(mediaPlayer._duckOriginalVolume, null);
});

test("restoreSystemVolume is a free no-op when nothing was ducked", async () => {
  const applyVolume = mock.method(mediaPlayer, "_applySystemVolume", async () => true);

  assert.equal(await mediaPlayer.restoreSystemVolume(), false);

  // Callers restore unconditionally on every stop path, so this must not spawn.
  assert.equal(applyVolume.mock.callCount(), 0);
});

test("restoreSystemVolume clears the latch even when the platform call fails", async () => {
  mock.method(mediaPlayer, "_applyDuck", async () => 80);
  mock.method(mediaPlayer, "_applySystemVolume", async () => false);

  await mediaPlayer.duckSystem(25);
  assert.equal(await mediaPlayer.restoreSystemVolume(), false);

  // A stuck latch would make every later duck a no-op and pin the user at the
  // ducked level for the rest of the session, so we never retry.
  assert.equal(mediaPlayer._duckActive, false);
});

test("duckSystem clamps the requested level", async () => {
  const applyDuck = mock.method(mediaPlayer, "_applyDuck", async () => 80);

  await mediaPlayer.duckSystem(-5);
  resetDuckState();
  await mediaPlayer.duckSystem(500);
  resetDuckState();
  await mediaPlayer.duckSystem(undefined);
  resetDuckState();
  await mediaPlayer.duckSystem("abc");

  assert.deepEqual(
    applyDuck.mock.calls.map((call) => call.arguments[0]),
    [0, 100, 25, 25]
  );
});

test("a restore requested mid-duck still runs after the duck settles", async () => {
  let releaseDuck;
  const duckLanded = new Promise((resolve) => {
    releaseDuck = resolve;
  });

  mock.method(mediaPlayer, "_applyDuck", () => duckLanded);
  const applyVolume = mock.method(mediaPlayer, "_applySystemVolume", async () => true);

  const ducking = mediaPlayer.duckSystem(25);
  const restoring = mediaPlayer.restoreSystemVolume();

  releaseDuck(80);
  await ducking;
  await restoring;

  // Without serialization the restore resolves first, sees no active duck, and
  // the duck latches afterwards — leaving the user quiet with nothing to undo.
  assert.equal(applyVolume.mock.callCount(), 1);
  assert.deepEqual(applyVolume.mock.calls[0].arguments, [80]);
  assert.equal(mediaPlayer._duckActive, false);
});

test("_clampVolume coerces to an integer within 0-100", () => {
  assert.equal(mediaPlayer._clampVolume(50), 50);
  assert.equal(mediaPlayer._clampVolume(-5), 0);
  assert.equal(mediaPlayer._clampVolume(500), 100);
  assert.equal(mediaPlayer._clampVolume(42.6), 43);
  assert.equal(mediaPlayer._clampVolume("70"), 70);
  assert.equal(mediaPlayer._clampVolume("abc"), 25);
  assert.equal(mediaPlayer._clampVolume(undefined), 25);
  assert.equal(mediaPlayer._clampVolume(null, 30), 0);
  assert.equal(mediaPlayer._clampVolume(NaN, 30), 30);
});

test("_parseVolumePercent reads each platform's output shape", () => {
  assert.equal(mediaPlayer._parseVolumePercent("__OWDUCK__:72", "win32"), 72);
  assert.equal(mediaPlayer._parseVolumePercent("__OWDUCK__:72", "darwin"), 72);

  // Add-Type warnings can precede the value on stdout.
  assert.equal(mediaPlayer._parseVolumePercent("WARNING: something\n__OWDUCK__:64", "win32"), 64);

  assert.equal(
    mediaPlayer._parseVolumePercent(
      "Volume: front-left: 45874 /  70% / -7.85 dB,   front-right: 45874 /  70% / -7.85 dB",
      "pactl"
    ),
    70
  );
  assert.equal(mediaPlayer._parseVolumePercent("Volume: 0.65", "wpctl"), 65);

  assert.equal(mediaPlayer._parseVolumePercent("missing value", "darwin"), null);
  assert.equal(mediaPlayer._parseVolumePercent("", "win32"), null);
  assert.equal(mediaPlayer._parseVolumePercent("no volume here", "pactl"), null);
  assert.equal(mediaPlayer._parseVolumePercent("anything", "unknown-kind"), null);
});
