const test = require("node:test");
const assert = require("node:assert/strict");

// Fake MediaStreamTrack: real EventTarget so add/removeEventListener behave normally.
class FakeTrack extends EventTarget {
  constructor({ muted = false, readyState = "live" } = {}) {
    super();
    this.muted = muted;
    this.readyState = readyState;
    this._listenerCount = 0;
  }

  addEventListener(type, cb) {
    this._listenerCount += 1;
    super.addEventListener(type, cb);
  }

  removeEventListener(type, cb) {
    this._listenerCount -= 1;
    super.removeEventListener(type, cb);
  }

  fire(type) {
    this.dispatchEvent(new Event(type));
  }
}

test("resolves false immediately for an ended track", async () => {
  const { waitForTrackReady } = await import("../../src/helpers/micTrackHealth.js");
  const track = new FakeTrack({ readyState: "ended" });
  assert.equal(await waitForTrackReady(track, 600), false);
  assert.equal(track._listenerCount, 0);
});

test("resolves false immediately for a null track", async () => {
  const { waitForTrackReady } = await import("../../src/helpers/micTrackHealth.js");
  assert.equal(await waitForTrackReady(null, 600), false);
});

test("resolves true immediately for an unmuted live track", async () => {
  const { waitForTrackReady } = await import("../../src/helpers/micTrackHealth.js");
  const track = new FakeTrack({ muted: false });
  assert.equal(await waitForTrackReady(track, 600), true);
  assert.equal(track._listenerCount, 0);
});

test("resolves true when a muted track fires unmute, with no listener leak", async () => {
  const { waitForTrackReady } = await import("../../src/helpers/micTrackHealth.js");
  const track = new FakeTrack({ muted: true });
  const pending = waitForTrackReady(track, 600);
  track.muted = false;
  track.fire("unmute");
  assert.equal(await pending, true);
  assert.equal(track._listenerCount, 0);
});

test("resolves false when a muted track fires ended, with no listener leak", async () => {
  const { waitForTrackReady } = await import("../../src/helpers/micTrackHealth.js");
  const track = new FakeTrack({ muted: true });
  const pending = waitForTrackReady(track, 600);
  track.readyState = "ended";
  track.fire("ended");
  assert.equal(await pending, false);
  assert.equal(track._listenerCount, 0);
});

test("resolves false after timeout when a muted track never changes", async (t) => {
  const { waitForTrackReady } = await import("../../src/helpers/micTrackHealth.js");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const track = new FakeTrack({ muted: true });
  const pending = waitForTrackReady(track, 600);
  t.mock.timers.tick(600);
  assert.equal(await pending, false);
  assert.equal(track._listenerCount, 0);
});

test("resolves true after timeout if the track quietly unmuted without firing", async (t) => {
  const { waitForTrackReady } = await import("../../src/helpers/micTrackHealth.js");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const track = new FakeTrack({ muted: true });
  const pending = waitForTrackReady(track, 600);
  track.muted = false; // unmuted but no event dispatched
  t.mock.timers.tick(600);
  assert.equal(await pending, true);
  assert.equal(track._listenerCount, 0);
});
