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

// Fake MediaStream: one track plus a stop-tracking flag, matching the bits reacquireIfDead touches.
class FakeStream {
  constructor(track) {
    this.track = track;
    this.stopped = false;
  }

  getAudioTracks() {
    return this.track ? [this.track] : [];
  }

  getTracks() {
    return this.track ? [this.track] : [];
  }
}

const noopLogger = { info() {}, warn() {} };

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
    assert.equal(stream.stopped, false);
  } finally {
    restore();
  }
});

test("reacquireIfDead returns the original stream for a trackless stream", async () => {
  const { reacquireIfDead } = await import("../../src/helpers/micTrackHealth.js");
  const stream = new FakeStream(null);
  let called = false;
  const restore = stubGetUserMedia(async () => {
    called = true;
  });
  try {
    assert.equal(await reacquireIfDead(stream, () => ({}), noopLogger), stream);
    assert.equal(called, false);
  } finally {
    restore();
  }
});

test("reacquireIfDead re-acquires once and stops the dead stream", async () => {
  const { reacquireIfDead } = await import("../../src/helpers/micTrackHealth.js");
  const deadTrack = new FakeTrack({ readyState: "ended" });
  deadTrack.stop = () => {
    deadTrack._stopped = true;
  };
  const stream = new FakeStream(deadTrack);
  const fresh = new FakeStream(new FakeTrack({ muted: false }));
  let constraintsCleared = false;
  const restore = stubGetUserMedia(async () => fresh);
  try {
    const result = await reacquireIfDead(
      stream,
      () => {
        constraintsCleared = true;
        return {};
      },
      noopLogger
    );
    assert.equal(result, fresh);
    assert.equal(constraintsCleared, true);
    assert.equal(deadTrack._stopped, true);
  } finally {
    restore();
  }
});

test("reacquireIfDead falls back to the original stream when the retry fails", async () => {
  const { reacquireIfDead } = await import("../../src/helpers/micTrackHealth.js");
  const deadTrack = new FakeTrack({ readyState: "ended" });
  deadTrack.stop = () => {};
  const stream = new FakeStream(deadTrack);
  const restore = stubGetUserMedia(async () => {
    throw new Error("device busy");
  });
  try {
    assert.equal(await reacquireIfDead(stream, () => ({}), noopLogger), stream);
  } finally {
    restore();
  }
});

// Track that records whether (and how often) reacquireIfDead stopped it.
function trackWithStop(options) {
  const track = new FakeTrack(options);
  track._stopCount = 0;
  track.stop = () => {
    track._stopCount += 1;
    track._stopped = true;
  };
  return track;
}

// Fallback options plus call counters, mirroring what audioManager passes in.
function spyFallback(getConstraints = () => ({})) {
  const calls = { getConstraints: 0, onDeviceRejected: 0, onFallbackUnusable: 0 };
  return {
    calls,
    options: {
      getConstraints: () => {
        calls.getConstraints += 1;
        return getConstraints();
      },
      onDeviceRejected: () => {
        calls.onDeviceRejected += 1;
      },
      onFallbackUnusable: () => {
        calls.onFallbackUnusable += 1;
      },
    },
  };
}

test("reacquireIfDead keeps the re-acquired stream when the retry track woke up", async () => {
  const { reacquireIfDead } = await import("../../src/helpers/micTrackHealth.js");
  const stream = new FakeStream(trackWithStop({ readyState: "ended" }));
  const retry = new FakeStream(trackWithStop({ muted: false }));
  const fallback = spyFallback();
  const restore = stubGetUserMedia(async () => retry);
  try {
    const result = await reacquireIfDead(stream, () => ({}), noopLogger, fallback.options);
    assert.equal(result, retry);
    assert.equal(fallback.calls.getConstraints, 0);
    assert.equal(fallback.calls.onDeviceRejected, 0);
    assert.equal(fallback.calls.onFallbackUnusable, 0);
    assert.equal(retry.track._stopped, undefined);
  } finally {
    restore();
  }
});

test("reacquireIfDead falls back to the default mic when the retry track is still dead", async () => {
  const { reacquireIfDead } = await import("../../src/helpers/micTrackHealth.js");
  const stream = new FakeStream(trackWithStop({ readyState: "ended" }));
  const retry = new FakeStream(trackWithStop({ readyState: "ended" }));
  const fallbackStream = new FakeStream(trackWithStop({ muted: false }));
  const fallback = spyFallback();
  let calls = 0;
  const restore = stubGetUserMedia(async () => {
    calls += 1;
    return calls === 1 ? retry : fallbackStream;
  });
  try {
    const result = await reacquireIfDead(stream, () => ({}), noopLogger, fallback.options);
    assert.equal(result, fallbackStream);
    assert.equal(fallback.calls.onDeviceRejected, 1);
    assert.equal(fallback.calls.getConstraints, 1);
    assert.equal(fallback.calls.onFallbackUnusable, 0);
    assert.equal(retry.track._stopped, true);
  } finally {
    restore();
  }
});

test("reacquireIfDead reports an unusable mic when the fallback track is dead too", async () => {
  const { reacquireIfDead } = await import("../../src/helpers/micTrackHealth.js");
  const stream = new FakeStream(trackWithStop({ readyState: "ended" }));
  const retry = new FakeStream(trackWithStop({ readyState: "ended" }));
  const fallbackStream = new FakeStream(trackWithStop({ readyState: "ended" }));
  const fallback = spyFallback();
  let calls = 0;
  const restore = stubGetUserMedia(async () => {
    calls += 1;
    return calls === 1 ? retry : fallbackStream;
  });
  try {
    const result = await reacquireIfDead(stream, () => ({}), noopLogger, fallback.options);
    assert.equal(result, fallbackStream);
    assert.equal(fallback.calls.onDeviceRejected, 1);
    assert.equal(fallback.calls.onFallbackUnusable, 1);
  } finally {
    restore();
  }
});

test("reacquireIfDead reports an unusable mic when the fallback request fails", async () => {
  const { reacquireIfDead } = await import("../../src/helpers/micTrackHealth.js");
  const stream = new FakeStream(trackWithStop({ readyState: "ended" }));
  const retry = new FakeStream(trackWithStop({ readyState: "ended" }));
  const fallback = spyFallback();
  let calls = 0;
  const restore = stubGetUserMedia(async () => {
    calls += 1;
    if (calls === 1) return retry;
    throw new Error("device busy");
  });
  try {
    const result = await reacquireIfDead(stream, () => ({}), noopLogger, fallback.options);
    assert.equal(result, retry);
    assert.equal(fallback.calls.onDeviceRejected, 1);
    assert.equal(fallback.calls.onFallbackUnusable, 1);
    assert.equal(retry.track._stopped, undefined);
  } finally {
    restore();
  }
});

test("reacquireIfDead falls back to the default mic when the retry request fails", async () => {
  const { reacquireIfDead } = await import("../../src/helpers/micTrackHealth.js");
  const stream = new FakeStream(trackWithStop({ readyState: "ended" }));
  const fallbackStream = new FakeStream(trackWithStop({ muted: false }));
  const fallback = spyFallback();
  let calls = 0;
  const restore = stubGetUserMedia(async () => {
    calls += 1;
    if (calls === 1) throw new Error("device busy");
    return fallbackStream;
  });
  try {
    const result = await reacquireIfDead(stream, () => ({}), noopLogger, fallback.options);
    assert.equal(result, fallbackStream);
    assert.equal(fallback.calls.onDeviceRejected, 1);
    assert.equal(fallback.calls.onFallbackUnusable, 0);
    assert.equal(stream.track._stopCount, 1);
  } finally {
    restore();
  }
});

test("reacquireIfDead reports an unusable mic when the retry and the fallback both fail", async () => {
  const { reacquireIfDead } = await import("../../src/helpers/micTrackHealth.js");
  const stream = new FakeStream(trackWithStop({ readyState: "ended" }));
  const fallback = spyFallback();
  const restore = stubGetUserMedia(async () => {
    throw new Error("device busy");
  });
  try {
    const result = await reacquireIfDead(stream, () => ({}), noopLogger, fallback.options);
    assert.equal(result, stream);
    assert.equal(fallback.calls.onDeviceRejected, 1);
    assert.equal(fallback.calls.onFallbackUnusable, 1);
    assert.equal(stream.track._stopCount, 0);
  } finally {
    restore();
  }
});

test("reacquireIfDead falls back when the re-acquired track stays muted", async (t) => {
  const { reacquireIfDead } = await import("../../src/helpers/micTrackHealth.js");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const stream = new FakeStream(trackWithStop({ readyState: "ended" }));
  const retry = new FakeStream(trackWithStop({ muted: true }));
  const fallbackStream = new FakeStream(trackWithStop({ muted: false }));
  const fallback = spyFallback();
  let calls = 0;
  const restore = stubGetUserMedia(async () => {
    calls += 1;
    return calls === 1 ? retry : fallbackStream;
  });
  try {
    const pending = reacquireIfDead(stream, () => ({}), noopLogger, fallback.options);
    // Let the retry's readiness timer register before firing it.
    await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(600);
    assert.equal(await pending, fallbackStream);
    assert.equal(fallback.calls.onDeviceRejected, 1);
    assert.equal(fallback.calls.onFallbackUnusable, 0);
    assert.equal(retry.track._stopped, true);
    assert.equal(retry.track._listenerCount, 0);
  } finally {
    restore();
  }
});
