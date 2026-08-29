const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/micStreamHold.js");

const fakeTrack = ({ live = true, muted = false } = {}) => {
  const track = {
    readyState: live ? "live" : "ended",
    muted,
    stopped: 0,
    clones: 0,
    stop() {
      this.stopped += 1;
      this.readyState = "ended";
    },
    clone() {
      this.clones += 1;
      return { cloneOf: track };
    },
  };
  return track;
};

const fakeStream = (track) => ({ getAudioTracks: () => [track] });

const makeHold = async (options = {}) => {
  const { MicStreamHold } = await load();
  const timers = { armed: [], cleared: [] };
  const events = [];
  const hold = new MicStreamHold({
    holdSeconds: 10,
    setTimer: (fn, ms) => {
      const id = timers.armed.push({ fn, ms });
      return id;
    },
    clearTimer: (id) => timers.cleared.push(id),
    onHoldChange: (active) => events.push(active),
    makeStream: (track) => ({ wrapped: track }),
    ...options,
  });
  return { hold, timers, events };
};

test("disabled hold passes the stream through and keeps nothing", async () => {
  const { hold, events } = await makeHold({ holdSeconds: 0 });
  const track = fakeTrack();
  const stream = fakeStream(track);

  assert.equal(hold.adoptAndClone(stream, "key"), stream);
  assert.equal(hold.active, false);
  assert.equal(hold.acquireClone("key"), null);
  assert.equal(track.clones, 0);
  assert.deepEqual(events, []);
});

test("adoptAndClone stores the master and returns a clone", async () => {
  const { hold, events } = await makeHold();
  const track = fakeTrack();

  const clone = hold.adoptAndClone(fakeStream(track), "key");

  assert.equal(track.clones, 1);
  assert.equal(clone.wrapped.cloneOf, track);
  assert.equal(hold.active, true);
  assert.deepEqual(events, [true]);
});

test("replacing the master is a silent swap, not a release+acquire", async () => {
  const { hold, events } = await makeHold();
  const first = fakeTrack();
  const second = fakeTrack();

  hold.adoptAndClone(fakeStream(first), "key");
  const clone = hold.adoptAndClone(fakeStream(second), "key2");

  assert.equal(first.stopped, 1);
  assert.equal(clone.wrapped.cloneOf, second);
  assert.equal(hold.active, true);
  // One continuous hold: no false→true blip from the swap.
  assert.deepEqual(events, [true]);
});

test("acquireClone returns fresh clones while the master is live", async () => {
  const { hold } = await makeHold();
  const track = fakeTrack();
  hold.adoptAndClone(fakeStream(track), "key");

  const clone = hold.acquireClone("key");

  assert.equal(track.clones, 2);
  assert.equal(clone.wrapped.cloneOf, track);
});

test("acquireClone drops the master on constraints mismatch", async () => {
  const { hold, events } = await makeHold();
  const track = fakeTrack();
  hold.adoptAndClone(fakeStream(track), "key");

  assert.equal(hold.acquireClone("other"), null);
  assert.equal(track.stopped, 1);
  assert.equal(hold.active, false);
  assert.deepEqual(events, [true, false]);
});

test("acquireClone drops a dead or muted master", async () => {
  for (const state of [{ live: false }, { muted: true }]) {
    const { hold } = await makeHold();
    const track = fakeTrack(state);
    hold.adoptAndClone(fakeStream(track), "key");

    assert.equal(hold.acquireClone("key"), null);
    assert.equal(hold.active, false);
  }
});

test("the release timer stops the master and can be re-armed by touch", async () => {
  const { hold, timers, events } = await makeHold();
  const track = fakeTrack();
  hold.adoptAndClone(fakeStream(track), "key");

  assert.equal(timers.armed.length, 1);
  assert.equal(timers.armed[0].ms, 10000);

  hold.touch();
  assert.equal(timers.cleared.length, 1);
  assert.equal(timers.armed.length, 2);

  timers.armed[1].fn();
  assert.equal(track.stopped, 1);
  assert.equal(hold.active, false);
  assert.deepEqual(events, [true, false]);
});

test("a release firing mid-recording defers instead of dropping the master", async () => {
  let busy = true;
  const { hold, timers, events } = await makeHold({ isBusy: () => busy });
  const track = fakeTrack();
  hold.adoptAndClone(fakeStream(track), "key");

  timers.armed[0].fn();
  assert.equal(track.stopped, 0);
  assert.equal(hold.active, true);
  assert.equal(timers.armed.length, 2);

  busy = false;
  timers.armed[1].fn();
  assert.equal(track.stopped, 1);
  assert.equal(hold.active, false);
  assert.deepEqual(events, [true, false]);
});

test("setHoldSeconds(0) drops a live master immediately", async () => {
  const { hold, events } = await makeHold();
  const track = fakeTrack();
  hold.adoptAndClone(fakeStream(track), "key");

  hold.setHoldSeconds(0);

  assert.equal(track.stopped, 1);
  assert.equal(hold.active, false);
  assert.deepEqual(events, [true, false]);
});

test("drop is idempotent and silent when nothing is held", async () => {
  const { hold, events } = await makeHold();
  hold.drop();
  hold.drop();

  assert.deepEqual(events, []);
});
