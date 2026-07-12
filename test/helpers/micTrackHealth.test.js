const test = require("node:test");
const assert = require("node:assert/strict");

// Fake MediaStreamTrack: real EventTarget so add/removeEventListener behave normally.
class FakeTrack extends EventTarget {
  constructor({ muted = false, readyState = "live" } = {}) {
    super();
    this.muted = muted;
    this.readyState = readyState;
    this.stopped = false;
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

  stop() {
    this.stopped = true;
    this.readyState = "ended";
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

// Fake MediaStream: one track, matching the browser surface reacquireIfDead touches.
class FakeStream {
  constructor(track) {
    this.track = track;
  }

  getAudioTracks() {
    return this.track ? [this.track] : [];
  }

  getTracks() {
    return this.track ? [this.track] : [];
  }
}

const noopLogger = { debug() {}, info() {}, warn() {} };

function stubGetUserMedia(impl) {
  const original = globalThis.navigator;
  Object.defineProperty(globalThis, "navigator", {
    value: { mediaDevices: { getUserMedia: impl } },
    configurable: true,
  });
  return () =>
    Object.defineProperty(globalThis, "navigator", { value: original, configurable: true });
}

test("reacquireIfDead returns the original stream and never retries a healthy track", async () => {
  const { reacquireIfDead } = await import("../../src/helpers/micTrackHealth.js");
  const stream = new FakeStream(new FakeTrack({ muted: false }));
  let called = false;
  const restore = stubGetUserMedia(async () => {
    called = true;
  });
  try {
    const result = await reacquireIfDead(stream, () => ({}), noopLogger);
    assert.equal(result, stream);
    assert.equal(called, false);
    assert.equal(stream.track.stopped, false);
  } finally {
    restore();
  }
});

test("reacquireIfDead falls back once for a trackless stream", async () => {
  const { reacquireIfDead } = await import("../../src/helpers/micTrackHealth.js");
  const stream = new FakeStream(null);
  const fallback = new FakeStream(new FakeTrack());
  let calls = 0;
  const restore = stubGetUserMedia(async () => {
    calls += 1;
    return fallback;
  });
  try {
    assert.equal(await reacquireIfDead(stream, () => ({ audio: true }), noopLogger), fallback);
    assert.equal(calls, 1);
  } finally {
    restore();
  }
});

test("reacquireIfDead invalidates the pinned cache before one unpinned retry", async () => {
  const { reacquireIfDead } = await import("../../src/helpers/micTrackHealth.js");
  const deadTrack = new FakeTrack({ readyState: "ended" });
  const stream = new FakeStream(deadTrack);
  const fresh = new FakeStream(new FakeTrack({ muted: false }));
  const fallbackConstraints = { audio: { echoCancellation: false } };
  let cachedDeviceId = "realtek-device";
  let unavailableDeviceId = null;
  const pinnedDeviceId = cachedDeviceId;
  const calls = [];
  const restore = stubGetUserMedia(async (constraints) => {
    calls.push(constraints);
    return fresh;
  });
  try {
    const result = await reacquireIfDead(
      stream,
      () => {
        cachedDeviceId = null;
        return fallbackConstraints;
      },
      noopLogger,
      {
        onFallbackSuccess: () => {
          unavailableDeviceId = pinnedDeviceId;
        },
      }
    );
    assert.equal(result, fresh);
    assert.deepEqual(calls, [fallbackConstraints]);
    assert.equal(cachedDeviceId, null);
    assert.equal(unavailableDeviceId, "realtek-device");
    assert.equal(deadTrack.stopped, true);
  } finally {
    restore();
  }
});

test("reacquireIfDead waits for a muted preferred track before falling back", async (t) => {
  const { reacquireIfDead } = await import("../../src/helpers/micTrackHealth.js");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const mutedTrack = new FakeTrack({ muted: true });
  const stream = new FakeStream(mutedTrack);
  const fallback = new FakeStream(new FakeTrack());
  let calls = 0;
  const restore = stubGetUserMedia(async () => {
    calls += 1;
    return fallback;
  });
  try {
    const pending = reacquireIfDead(stream, () => ({ audio: true }), noopLogger);
    await Promise.resolve();
    assert.equal(calls, 0);
    t.mock.timers.tick(600);
    assert.equal(await pending, fallback);
    assert.equal(calls, 1);
    assert.equal(mutedTrack.stopped, true);
  } finally {
    restore();
  }
});

test("reacquireIfDead retains a preferred track that unmutes within the grace period", async () => {
  const { reacquireIfDead } = await import("../../src/helpers/micTrackHealth.js");
  const mutedTrack = new FakeTrack({ muted: true });
  const stream = new FakeStream(mutedTrack);
  let calls = 0;
  const restore = stubGetUserMedia(async () => {
    calls += 1;
  });
  try {
    const pending = reacquireIfDead(stream, () => ({ audio: true }), noopLogger);
    await Promise.resolve();
    mutedTrack.muted = false;
    mutedTrack.fire("unmute");
    assert.equal(await pending, stream);
    assert.equal(calls, 0);
    assert.equal(mutedTrack.stopped, false);
  } finally {
    restore();
  }
});

test("reacquireIfDead falls back once when preferred acquisition rejects", async () => {
  const { reacquireIfDead } = await import("../../src/helpers/micTrackHealth.js");
  const fallback = new FakeStream(new FakeTrack());
  let calls = 0;
  let fallbackReason = null;
  const restore = stubGetUserMedia(async () => {
    calls += 1;
    return fallback;
  });
  try {
    const preferredError = Object.assign(new Error("preferred device unavailable"), {
      name: "NotReadableError",
    });
    const result = await reacquireIfDead(
      Promise.reject(preferredError),
      () => ({ audio: true }),
      noopLogger,
      {
        fallbackOnAcquisitionError: true,
        onFallbackSuccess: ({ reason }) => {
          fallbackReason = reason;
        },
      }
    );
    assert.equal(result, fallback);
    assert.equal(calls, 1);
    assert.equal(fallbackReason, "acquisition-error");
  } finally {
    restore();
  }
});

test("reacquireIfDead surfaces a generic acquisition error when fallback is disabled", async () => {
  const { reacquireIfDead } = await import("../../src/helpers/micTrackHealth.js");
  let calls = 0;
  const restore = stubGetUserMedia(async () => {
    calls += 1;
  });
  try {
    const preferredError = Object.assign(new Error("selected microphone is in use"), {
      name: "NotReadableError",
    });
    await assert.rejects(
      reacquireIfDead(Promise.reject(preferredError), () => ({ audio: true }), noopLogger),
      (error) => error === preferredError
    );
    assert.equal(calls, 0);
  } finally {
    restore();
  }
});

test("reacquireIfDead still falls back for a stale device when generic fallback is disabled", async () => {
  const { reacquireIfDead } = await import("../../src/helpers/micTrackHealth.js");
  const fallback = new FakeStream(new FakeTrack());
  let calls = 0;
  const restore = stubGetUserMedia(async () => {
    calls += 1;
    return fallback;
  });
  try {
    const staleDeviceError = Object.assign(new Error("saved microphone no longer exists"), {
      name: "OverconstrainedError",
      constraint: "deviceId",
    });
    const result = await reacquireIfDead(
      Promise.reject(staleDeviceError),
      () => ({ audio: true }),
      noopLogger
    );
    assert.equal(result, fallback);
    assert.equal(calls, 1);
  } finally {
    restore();
  }
});

test("reacquireIfDead surfaces permission denial without retrying another device", async () => {
  const { reacquireIfDead } = await import("../../src/helpers/micTrackHealth.js");
  let calls = 0;
  const restore = stubGetUserMedia(async () => {
    calls += 1;
  });
  try {
    const permissionError = Object.assign(new Error("permission denied"), {
      name: "NotAllowedError",
    });
    await assert.rejects(
      reacquireIfDead(Promise.reject(permissionError), () => ({ audio: true }), noopLogger, {
        fallbackOnAcquisitionError: true,
      }),
      (error) => error === permissionError
    );
    assert.equal(calls, 0);
  } finally {
    restore();
  }
});

test("reacquireIfDead surfaces a failed default fallback without retrying again", async () => {
  const { reacquireIfDead } = await import("../../src/helpers/micTrackHealth.js");
  const deadTrack = new FakeTrack({ readyState: "ended" });
  const stream = new FakeStream(deadTrack);
  let calls = 0;
  let fallbackSucceeded = false;
  const restore = stubGetUserMedia(async () => {
    calls += 1;
    throw new Error("device busy");
  });
  try {
    await assert.rejects(
      reacquireIfDead(stream, () => ({ audio: true }), noopLogger, {
        onFallbackSuccess: () => {
          fallbackSucceeded = true;
        },
      }),
      /device busy/
    );
    assert.equal(calls, 1);
    assert.equal(fallbackSucceeded, false);
    assert.equal(deadTrack.stopped, true);
  } finally {
    restore();
  }
});

test("reacquireIfDead rejects and stops a persistently muted default fallback", async (t) => {
  const { reacquireIfDead } = await import("../../src/helpers/micTrackHealth.js");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const deadTrack = new FakeTrack({ readyState: "ended" });
  const fallbackTrack = new FakeTrack({ muted: true });
  const restore = stubGetUserMedia(async () => new FakeStream(fallbackTrack));
  try {
    const pending = reacquireIfDead(new FakeStream(deadTrack), () => ({ audio: true }), noopLogger);
    // Flush the async constraints and getUserMedia steps so the readiness timer is registered.
    for (let i = 0; i < 6; i++) await Promise.resolve();
    t.mock.timers.tick(600);
    await assert.rejects(pending, /default microphone.*ready/i);
    assert.equal(fallbackTrack.stopped, true);
  } finally {
    restore();
  }
});
