const test = require("node:test");
const { mock } = require("node:test");
const assert = require("node:assert/strict");

const mediaPlayer = require("../../src/helpers/mediaPlayer");

function platformMuteMethodName() {
  if (process.platform === "darwin") return "_muteMacOS";
  if (process.platform === "win32") return "_muteWindows";
  return "_muteLinux";
}

function platformUnmuteMethodName() {
  if (process.platform === "darwin") return "_unmuteMacOS";
  if (process.platform === "win32") return "_unmuteWindows";
  return "_unmuteLinux";
}

function resetMuteState() {
  mediaPlayer._didMute = false;
  mediaPlayer._wasMutedBefore = false;
}

test.beforeEach(() => {
  resetMuteState();
});

test.afterEach(() => {
  mock.restoreAll();
  resetMuteState();
});

test("muteSystem dispatches to platform helper and flips _didMute", () => {
  const spy = mock.method(mediaPlayer, platformMuteMethodName(), () => true);
  assert.equal(mediaPlayer.muteSystem(), true);
  assert.equal(mediaPlayer._didMute, true);
  assert.equal(spy.mock.callCount(), 1);
});

test("muteSystem is a no-op when already muted", () => {
  mediaPlayer._didMute = true;
  const spy = mock.method(mediaPlayer, platformMuteMethodName(), () => true);
  assert.equal(mediaPlayer.muteSystem(), true);
  assert.equal(spy.mock.callCount(), 0, "platform helper must not be invoked when already muted");
});

test("muteSystem leaves _didMute false when platform helper fails", () => {
  mock.method(mediaPlayer, platformMuteMethodName(), () => false);
  assert.equal(mediaPlayer.muteSystem(), false);
  assert.equal(mediaPlayer._didMute, false);
});

test("unmuteSystem is a no-op when we never muted", () => {
  const spy = mock.method(mediaPlayer, platformUnmuteMethodName(), () => true);
  assert.equal(mediaPlayer.unmuteSystem(), false);
  assert.equal(spy.mock.callCount(), 0);
});

test("unmuteSystem clears _didMute and calls platform helper", () => {
  mediaPlayer._didMute = true;
  const spy = mock.method(mediaPlayer, platformUnmuteMethodName(), () => true);
  assert.equal(mediaPlayer.unmuteSystem(), true);
  assert.equal(mediaPlayer._didMute, false);
  assert.equal(spy.mock.callCount(), 1);
});

test("unmuteSystem clears _didMute even when platform helper reports failure", () => {
  // We never want to retry the unmute on the next stop, so _didMute must clear.
  mediaPlayer._didMute = true;
  mock.method(mediaPlayer, platformUnmuteMethodName(), () => false);
  assert.equal(mediaPlayer.unmuteSystem(), false);
  assert.equal(mediaPlayer._didMute, false);
});
