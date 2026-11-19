const test = require("node:test");
const assert = require("node:assert/strict");
const { setImmediate: settleEvents } = require("node:timers/promises");

class FakeTrack extends EventTarget {
  constructor({ deviceId = "mic-1", groupId = "group-1", muted = false } = {}) {
    super();
    this.readyState = "live";
    this.muted = muted;
    this.settings = { deviceId, groupId };
    this.stopped = false;
  }

  getSettings() {
    return this.settings;
  }

  stop() {
    this.stopped = true;
    this.readyState = "ended";
  }
}

class FakeStream {
  constructor(track) {
    this.track = track;
  }

  getAudioTracks() {
    return this.track ? [this.track] : [];
  }

  getTracks() {
    return this.getAudioTracks();
  }
}

class FakeMediaDevices extends EventTarget {
  constructor(devices) {
    super();
    this.devices = devices;
    this.gate = null;
  }

  async enumerateDevices() {
    // A one-shot hold on the next enumeration, to land events mid-recovery.
    const gate = this.gate;
    this.gate = null;
    if (gate) await gate;
    return this.devices;
  }

  holdNextEnumeration() {
    let release;
    this.gate = new Promise((resolve) => (release = resolve));
    return release;
  }

  change(devices) {
    this.devices = devices;
    this.dispatchEvent(new Event("devicechange"));
  }
}

const mic = (deviceId, groupId = deviceId, label = deviceId) => ({
  kind: "audioinput",
  deviceId,
  groupId,
  label,
});

const speaker = (deviceId) => ({
  kind: "audiooutput",
  deviceId,
  groupId: deviceId,
  label: deviceId,
});
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("filters output-only changes and keeps a healthy pinned microphone", async () => {
  const { ActiveMicRecoveryController } = await import("../../src/helpers/activeMicRecovery.js");
  const mediaDevices = new FakeMediaDevices([mic("mic-1")]);
  const original = new FakeStream(new FakeTrack());
  let acquired = 0;
  const controller = new ActiveMicRecoveryController({
    mediaDevices,
    acquire: async () => {
      acquired += 1;
      return new FakeStream(new FakeTrack({ deviceId: "mic-2" }));
    },
    onRecovered: async () => {},
    debounceMs: 1,
  });
  await controller.start(original, { followDefault: false });
  mediaDevices.change([mic("mic-1"), speaker("speaker-2")]);
  await delay(10);
  assert.equal(acquired, 0);
  controller.stop();
});

test("recovers when the system default input changes", async () => {
  const { ActiveMicRecoveryController } = await import("../../src/helpers/activeMicRecovery.js");
  const mediaDevices = new FakeMediaDevices([mic("default", "group-1", "Mic One")]);
  const original = new FakeStream(new FakeTrack());
  const replacement = new FakeStream(new FakeTrack({ deviceId: "mic-2", groupId: "group-2" }));
  let recovered = null;
  const statuses = [];
  const controller = new ActiveMicRecoveryController({
    mediaDevices,
    acquire: async () => replacement,
    onRecovered: async (stream) => {
      recovered = stream;
    },
    onStatusChange: (status) => statuses.push(status),
    debounceMs: 1,
  });
  await controller.start(original, { followDefault: true });
  mediaDevices.change([mic("default", "group-2", "Mic Two")]);
  await delay(10);
  assert.equal(recovered, replacement);
  assert.deepEqual(statuses.slice(-2), ["reconnecting", "active"]);
  controller.stop();
});

test("track ended triggers recovery without waiting for devicechange", async () => {
  const { ActiveMicRecoveryController } = await import("../../src/helpers/activeMicRecovery.js");
  const mediaDevices = new FakeMediaDevices([mic("mic-1")]);
  const track = new FakeTrack();
  let acquired = 0;
  const controller = new ActiveMicRecoveryController({
    mediaDevices,
    acquire: async () => {
      acquired += 1;
      return new FakeStream(new FakeTrack({ deviceId: "mic-2" }));
    },
    onRecovered: async () => {},
  });
  await controller.start(new FakeStream(track));
  track.readyState = "ended";
  track.dispatchEvent(new Event("ended"));
  await delay(1);
  assert.equal(acquired, 1);
  controller.stop();
});

test("an unavailable microphone retries and later recovers", async () => {
  const { ActiveMicRecoveryController } = await import("../../src/helpers/activeMicRecovery.js");
  const mediaDevices = new FakeMediaDevices([mic("mic-1")]);
  const track = new FakeTrack();
  let attempts = 0;
  const statuses = [];
  const controller = new ActiveMicRecoveryController({
    mediaDevices,
    acquire: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("no mic");
      return new FakeStream(new FakeTrack({ deviceId: "mic-2" }));
    },
    onRecovered: async () => {},
    onStatusChange: (status) => statuses.push(status),
    retryMs: 5,
  });
  await controller.start(new FakeStream(track));
  track.readyState = "ended";
  track.dispatchEvent(new Event("ended"));
  await delay(20);
  assert.equal(attempts, 2);
  assert.ok(statuses.includes("unavailable"));
  assert.equal(statuses.at(-1), "active");
  controller.stop();
});

test("start() with an already-ended track recovers instead of reporting active", async () => {
  const { ActiveMicRecoveryController } = await import("../../src/helpers/activeMicRecovery.js");
  const mediaDevices = new FakeMediaDevices([mic("mic-1")]);
  const track = new FakeTrack();
  track.readyState = "ended";
  let acquired = 0;
  const statuses = [];
  const controller = new ActiveMicRecoveryController({
    mediaDevices,
    acquire: async () => {
      acquired += 1;
      return new FakeStream(new FakeTrack({ deviceId: "mic-2" }));
    },
    onRecovered: async () => {},
    onStatusChange: (status) => statuses.push(status),
  });
  await controller.start(new FakeStream(track));
  await delay(5);
  assert.equal(acquired, 1);
  assert.equal(statuses.at(-1), "active");
  controller.stop();
});

test("a stale recovery settling late cannot clobber a newer in-flight recovery", async () => {
  const { ActiveMicRecoveryController } = await import("../../src/helpers/activeMicRecovery.js");
  const mediaDevices = new FakeMediaDevices([mic("mic-1")]);
  const track1 = new FakeTrack();
  const track2 = new FakeTrack({ deviceId: "mic-2" });
  const pendingAcquires = [];
  const controller = new ActiveMicRecoveryController({
    mediaDevices,
    acquire: () => new Promise((resolve) => pendingAcquires.push(resolve)),
    onRecovered: async () => {},
  });
  await controller.start(new FakeStream(track1));
  track1.readyState = "ended";
  track1.dispatchEvent(new Event("ended"));
  assert.equal(pendingAcquires.length, 1);

  controller.stop();
  await controller.start(new FakeStream(track2));
  track2.readyState = "ended";
  track2.dispatchEvent(new Event("ended"));
  assert.equal(pendingAcquires.length, 2);

  pendingAcquires[0](new FakeStream(new FakeTrack({ deviceId: "stale" })));
  await delay(1);
  // The newer recovery is still in flight; another trigger must dedupe onto it.
  track2.dispatchEvent(new Event("ended"));
  await delay(1);
  assert.equal(pendingAcquires.length, 2);

  pendingAcquires[1](new FakeStream(new FakeTrack({ deviceId: "mic-3" })));
  await delay(1);
  controller.stop();
});

test("stop invalidates an in-flight acquisition and stops its late stream", async () => {
  const { ActiveMicRecoveryController } = await import("../../src/helpers/activeMicRecovery.js");
  const mediaDevices = new FakeMediaDevices([mic("mic-1")]);
  const track = new FakeTrack();
  const replacementTrack = new FakeTrack({ deviceId: "mic-2" });
  let resolveAcquire;
  let recovered = false;
  const controller = new ActiveMicRecoveryController({
    mediaDevices,
    acquire: () => new Promise((resolve) => (resolveAcquire = resolve)),
    onRecovered: async () => {
      recovered = true;
    },
  });
  await controller.start(new FakeStream(track));
  track.readyState = "ended";
  track.dispatchEvent(new Event("ended"));
  controller.stop();
  resolveAcquire(new FakeStream(replacementTrack));
  await delay(1);
  assert.equal(recovered, false);
  assert.equal(replacementTrack.stopped, true);
});

// What Chromium does when the OS source behind a track goes away.
const endTrack = (track) => {
  track.readyState = "ended";
  track.dispatchEvent(new Event("ended"));
};

test("a replacement that ends during the final enumeration retries instead of reporting active (#2743)", async () => {
  const { ActiveMicRecoveryController } = await import("../../src/helpers/activeMicRecovery.js");
  const mediaDevices = new FakeMediaDevices([mic("mic-1")]);
  const original = new FakeTrack();
  const replacements = [];
  const statuses = [];
  let release;
  const controller = new ActiveMicRecoveryController({
    mediaDevices,
    acquire: async () => {
      const track = new FakeTrack({ deviceId: "mic-1" });
      replacements.push(track);
      return new FakeStream(track);
    },
    onRecovered: async () => {
      if (replacements.length === 1) release = mediaDevices.holdNextEnumeration();
    },
    onStatusChange: (status) => statuses.push(status),
    retryMs: 5,
  });
  await controller.start(new FakeStream(original));
  endTrack(original);
  await delay(1);
  // Its listener is attached, so this `ended` reaches recover(), which folds it
  // into the attempt still waiting on enumeration.
  endTrack(replacements[0]);
  release();
  await delay(30);
  assert.equal(replacements.length, 2);
  assert.ok(statuses.includes("unavailable"));
  assert.equal(statuses.at(-1), "active");
  assert.equal(controller.track, replacements[1]);
  assert.equal(controller.track.readyState, "live");
  controller.stop();
});

test("a replacement whose recorder stops on a dead track before recovery settles retries", async () => {
  const { ActiveMicRecoveryController } = await import("../../src/helpers/activeMicRecovery.js");
  const mediaDevices = new FakeMediaDevices([mic("mic-1")]);
  const original = new FakeTrack();
  const replacements = [];
  const statuses = [];
  let controller;
  controller = new ActiveMicRecoveryController({
    mediaDevices,
    acquire: async () => {
      const track = new FakeTrack({ deviceId: "mic-1" });
      replacements.push(track);
      return new FakeStream(track);
    },
    // Like audioManager.replaceBatchMic: the replacement's recorder exists before
    // recovery settles. Its track dies before the controller listens to it, and
    // the recorder's onstop asks for recovery, which folds into this attempt.
    onRecovered: async () => {
      if (replacements.length !== 1) return;
      endTrack(replacements[0]);
      controller.recover("recorder-stopped");
    },
    onStatusChange: (status) => statuses.push(status),
    retryMs: 5,
  });
  await controller.start(new FakeStream(original));
  endTrack(original);
  await delay(30);
  assert.equal(replacements.length, 2);
  assert.ok(statuses.includes("unavailable"));
  assert.equal(statuses.at(-1), "active");
  assert.equal(controller.track.readyState, "live");
  controller.stop();
});

test("the old recorder stopping during recovery does not start a second recovery", async () => {
  const { ActiveMicRecoveryController } = await import("../../src/helpers/activeMicRecovery.js");
  const mediaDevices = new FakeMediaDevices([mic("mic-1")]);
  const original = new FakeTrack();
  let acquired = 0;
  const statuses = [];
  const controller = new ActiveMicRecoveryController({
    mediaDevices,
    acquire: async () => {
      acquired += 1;
      return new FakeStream(new FakeTrack({ deviceId: "mic-1" }));
    },
    onRecovered: async () => {},
    onStatusChange: (status) => statuses.push(status),
    retryMs: 5,
  });
  await controller.start(new FakeStream(original));
  endTrack(original);
  controller.recover("recorder-stopped");
  await delay(30);
  assert.equal(acquired, 1);
  assert.deepEqual(statuses, ["active", "reconnecting", "active"]);
  controller.stop();
});

test("a replacement whose recorder fails to start leaves the original microphone watched", async (t) => {
  const { ActiveMicRecoveryController } = await import("../../src/helpers/activeMicRecovery.js");
  const mediaDevices = new FakeMediaDevices([mic("mic-1")]);
  const original = new FakeTrack();
  const replacement = new FakeTrack({ deviceId: "mic-2" });
  const controller = new ActiveMicRecoveryController({
    mediaDevices,
    acquire: async () => new FakeStream(replacement),
    onRecovered: async () => {
      throw new Error("recorder failed");
    },
    debounceMs: 1,
    retryMs: 10000,
  });
  t.after(() => controller.stop());
  await controller.start(new FakeStream(original));
  mediaDevices.change([mic("mic-2"), mic("mic-1")]);
  await delay(10);
  assert.equal(replacement.stopped, true);
  assert.equal(controller.track, original);
  assert.equal(controller.status, "unavailable");
});

test("a recording restarted during the final enumeration keeps its own status", async () => {
  const { ActiveMicRecoveryController } = await import("../../src/helpers/activeMicRecovery.js");
  const mediaDevices = new FakeMediaDevices([mic("mic-1")]);
  const first = new FakeTrack();
  const second = new FakeTrack();
  let acquired = 0;
  let release;
  const controller = new ActiveMicRecoveryController({
    mediaDevices,
    acquire: async () => {
      acquired += 1;
      if (acquired === 2) throw new Error("no mic");
      return new FakeStream(new FakeTrack({ deviceId: "mic-1" }));
    },
    onRecovered: async () => {
      if (acquired === 1) release = mediaDevices.holdNextEnumeration();
    },
    retryMs: 10000,
  });
  await controller.start(new FakeStream(first));
  endTrack(first);
  await delay(1);
  controller.stop();
  await controller.start(new FakeStream(second));
  endTrack(second);
  await delay(1);
  assert.equal(controller.status, "unavailable");
  release();
  await delay(5);
  assert.equal(controller.status, "unavailable");
  assert.equal(controller.track, second);
  controller.stop();
});

test("a replacement that opens muted is recovered once its grace expires", async () => {
  const { ActiveMicRecoveryController } = await import("../../src/helpers/activeMicRecovery.js");
  const mediaDevices = new FakeMediaDevices([mic("mic-1")]);
  const original = new FakeTrack();
  const reasons = [];
  const controller = new ActiveMicRecoveryController({
    mediaDevices,
    acquire: async (reason) => {
      reasons.push(reason);
      return new FakeStream(new FakeTrack({ deviceId: "mic-1", muted: reasons.length === 1 }));
    },
    onRecovered: async () => {},
    muteGraceMs: 5,
  });
  await controller.start(new FakeStream(original));
  endTrack(original);
  await delay(30);
  assert.deepEqual(reasons, ["ended", "muted"]);
  assert.equal(controller.track.muted, false);
  assert.equal(controller.status, "active");
  controller.stop();
});

test("a microphone muted at the OS level is not reopened in a loop", async () => {
  const { ActiveMicRecoveryController } = await import("../../src/helpers/activeMicRecovery.js");
  const mediaDevices = new FakeMediaDevices([mic("mic-1")]);
  const original = new FakeTrack();
  const reasons = [];
  const controller = new ActiveMicRecoveryController({
    mediaDevices,
    acquire: async (reason) => {
      reasons.push(reason);
      return new FakeStream(new FakeTrack({ deviceId: "mic-1", muted: true }));
    },
    onRecovered: async () => {},
    muteGraceMs: 5,
  });
  await controller.start(new FakeStream(original));
  original.muted = true;
  original.dispatchEvent(new Event("mute"));
  await delay(40);
  assert.deepEqual(reasons, ["muted"]);
  assert.equal(controller.status, "unavailable");
  controller.track.muted = false;
  controller.track.dispatchEvent(new Event("unmute"));
  assert.equal(controller.status, "active");
  controller.stop();
});

test("logs a recovery's start, its first failure, and the recovery", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { ActiveMicRecoveryController } = await import("../../src/helpers/activeMicRecovery.js");
  const mediaDevices = new FakeMediaDevices([mic("mic-1")]);
  const original = new FakeTrack();
  const lines = [];
  const record = (level) => (message, meta, scope) => lines.push({ level, message, meta, scope });
  let attempts = 0;
  const controller = new ActiveMicRecoveryController({
    mediaDevices,
    acquire: async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("no mic");
      return new FakeStream(new FakeTrack({ deviceId: "mic-1" }));
    },
    onRecovered: async () => {},
    retryMs: 5,
    logger: { debug: record("debug"), info: record("info"), warn: record("warn") },
    logScope: "meeting",
  });
  await controller.start(new FakeStream(original));
  endTrack(original);
  await settleEvents();
  t.mock.timers.tick(5);
  await settleEvents();
  t.mock.timers.tick(5);
  await settleEvents();
  assert.equal(attempts, 3);
  const notable = lines.filter((line) => line.level !== "debug");
  assert.deepEqual(
    notable.map((line) => [line.level, line.message]),
    [
      ["info", "Microphone recovery started"],
      ["warn", "Microphone recovery failed"],
      ["info", "Microphone recovered"],
    ]
  );
  assert.equal(notable[0].meta.reason, "ended");
  assert.equal(notable[1].meta.error, "no mic");
  assert.equal(notable[2].meta.failedAttempts, 2);
  // The whole outage, not just the attempt that succeeded.
  assert.equal(notable[2].meta.durationMs, 10);
  assert.ok(lines.every((line) => line.scope === "meeting"));
  // The second failure in the same outage stays at debug.
  assert.ok(
    lines.some((line) => line.level === "debug" && line.message === "Microphone recovery failed")
  );
  controller.stop();
});

for (const { elapsed, firstReason } of [
  { elapsed: 799, firstReason: "ended" },
  { elapsed: 800, firstReason: "muted" },
]) {
  test(`a fresh mute on a replacement keeps its deadline after ${elapsed} ms of enumeration`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { ActiveMicRecoveryController } = await import("../../src/helpers/activeMicRecovery.js");
    const original = new FakeTrack();
    const replacement = new FakeTrack();
    const mediaDevices = new FakeMediaDevices([mic("mic-1")]);
    const reasons = [];
    const controller = new ActiveMicRecoveryController({
      mediaDevices,
      acquire: async (reason) => {
        reasons.push(reason);
        return new FakeStream(reasons.length === 1 ? replacement : new FakeTrack());
      },
      onRecovered: async () => {},
    });
    t.after(() => controller.stop());
    await controller.start(new FakeStream(original));
    const release = mediaDevices.holdNextEnumeration();
    if (firstReason === "muted") {
      original.muted = true;
      original.dispatchEvent(new Event("mute"));
      t.mock.timers.tick(800);
    } else {
      endTrack(original);
    }
    await settleEvents();
    replacement.muted = true;
    replacement.dispatchEvent(new Event("mute"));
    t.mock.timers.tick(elapsed);
    await settleEvents();
    release();
    await settleEvents();
    if (elapsed < 800) {
      assert.equal(reasons.length, 1);
      t.mock.timers.tick(800 - elapsed);
      await settleEvents();
    }
    assert.deepEqual(reasons, [firstReason, "muted"]);
    assert.equal(controller.status, "active");
    assert.equal(controller.track.muted, false);
  });
}

test("a failed mute recovery keeps its origin and announces restoration only on unmute", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { ActiveMicRecoveryController } = await import("../../src/helpers/activeMicRecovery.js");
  const original = new FakeTrack();
  const replacement = new FakeTrack({ muted: true });
  const mediaDevices = new FakeMediaDevices([mic("mic-1")]);
  const statuses = [];
  let attempts = 0;
  const controller = new ActiveMicRecoveryController({
    mediaDevices,
    acquire: async () => {
      if (++attempts === 1) throw new Error("busy");
      return new FakeStream(replacement);
    },
    onRecovered: async () => {},
    onStatusChange: (status) => statuses.push(status),
  });
  t.after(() => controller.stop());
  await controller.start(new FakeStream(original));
  original.muted = true;
  original.dispatchEvent(new Event("mute"));
  t.mock.timers.tick(800);
  await settleEvents();
  t.mock.timers.tick(2000);
  await settleEvents();
  mediaDevices.change([mic("mic-1"), speaker("speaker-2")]);
  t.mock.timers.tick(10000);
  await settleEvents();
  assert.equal(attempts, 2);
  assert.equal(controller.status, "unavailable");
  assert.equal(statuses.filter((status) => status === "active").length, 1);
  replacement.muted = false;
  replacement.dispatchEvent(new Event("unmute"));
  assert.equal(controller.status, "active");
  assert.equal(statuses.filter((status) => status === "active").length, 2);
});

for (const eventDuringEnumeration of [true, false]) {
  test(`follows the latest default when the devicechange debounce runs ${eventDuringEnumeration ? "during" : "after"} recovery`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { ActiveMicRecoveryController } = await import("../../src/helpers/activeMicRecovery.js");
    const mediaDevices = new FakeMediaDevices([mic("A")]);
    const selections = [];
    const controller = new ActiveMicRecoveryController({
      mediaDevices,
      acquire: async (reason) => {
        const deviceId = mediaDevices.devices[0].deviceId;
        selections.push([reason, deviceId]);
        return new FakeStream(new FakeTrack({ deviceId }));
      },
      onRecovered: async () => {},
    });
    t.after(() => controller.stop());
    await controller.start(new FakeStream(new FakeTrack({ deviceId: "A" })));
    mediaDevices.change([mic("B"), mic("A")]);
    // Hold the post-swap snapshot for B while the operating system makes C default.
    const enumerate = mediaDevices.enumerateDevices.bind(mediaDevices);
    const snapshot = Promise.withResolvers();
    let reads = 0;
    mediaDevices.enumerateDevices = () => (++reads === 2 ? snapshot.promise : enumerate());
    t.mock.timers.tick(250);
    await settleEvents();
    assert.deepEqual(selections, [["devicechange", "B"]]);
    mediaDevices.change([mic("C"), mic("B"), mic("A")]);
    if (eventDuringEnumeration) {
      t.mock.timers.tick(250);
      await settleEvents();
    }
    snapshot.resolve(eventDuringEnumeration ? [mic("B"), mic("A")] : mediaDevices.devices);
    await settleEvents();
    t.mock.timers.tick(250);
    await settleEvents();
    assert.deepEqual(selections, [
      ["devicechange", "B"],
      ["devicechange", "C"],
    ]);
    assert.equal(controller.track.getSettings().deviceId, "C");
    assert.equal(controller.status, "active");
  });
}

test("an unplug that already selected the new default uses just one replacement", async (t) => {
  const { ActiveMicRecoveryController } = await import("../../src/helpers/activeMicRecovery.js");
  const mediaDevices = new FakeMediaDevices([mic("default", "A")]);
  const original = new FakeTrack({ deviceId: "A", groupId: "A" });
  const selections = [];
  const controller = new ActiveMicRecoveryController({
    mediaDevices,
    acquire: async (reason) => {
      selections.push(reason);
      return new FakeStream(new FakeTrack({ deviceId: "B", groupId: "B" }));
    },
    onRecovered: async () => {},
  });
  t.after(() => controller.stop());
  await controller.start(new FakeStream(original));
  mediaDevices.devices = [mic("default", "B"), mic("B")];
  endTrack(original);
  await settleEvents();
  assert.deepEqual(selections, ["ended"]);
  assert.equal(controller.status, "active");
  assert.equal(controller.track.getSettings().deviceId, "B");
});

test("a fresh mute during recorder rotation keeps its deadline even if the track opened muted", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { ActiveMicRecoveryController } = await import("../../src/helpers/activeMicRecovery.js");
  const original = new FakeTrack();
  const replacement = new FakeTrack({ muted: true });
  const rotation = Promise.withResolvers();
  const reasons = [];
  const controller = new ActiveMicRecoveryController({
    mediaDevices: new FakeMediaDevices([mic("mic-1")]),
    acquire: async (reason) => {
      reasons.push(reason);
      return new FakeStream(reasons.length === 1 ? replacement : new FakeTrack());
    },
    onRecovered: () => rotation.promise,
  });
  t.after(() => controller.stop());
  await controller.start(new FakeStream(original));
  original.muted = true;
  original.dispatchEvent(new Event("mute"));
  t.mock.timers.tick(800);
  await settleEvents();
  replacement.muted = false;
  replacement.dispatchEvent(new Event("unmute"));
  replacement.muted = true;
  replacement.dispatchEvent(new Event("mute"));
  t.mock.timers.tick(900);
  await settleEvents();
  assert.deepEqual(reasons, ["muted"]);
  rotation.resolve();
  await settleEvents();
  assert.deepEqual(reasons, ["muted", "muted"]);
  assert.equal(controller.status, "active");
});

test("a late devicechange read cannot rotate the newly selected default again", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { ActiveMicRecoveryController } = await import("../../src/helpers/activeMicRecovery.js");
  const mediaDevices = new FakeMediaDevices([mic("A")]);
  const selections = [];
  const controller = new ActiveMicRecoveryController({
    mediaDevices,
    acquire: async () => {
      const deviceId = mediaDevices.devices[0].deviceId;
      selections.push(deviceId);
      return new FakeStream(new FakeTrack({ deviceId }));
    },
    onRecovered: async () => {},
  });
  t.after(() => controller.stop());
  await controller.start(new FakeStream(new FakeTrack({ deviceId: "A" })));
  const release = mediaDevices.holdNextEnumeration();
  mediaDevices.change([mic("A"), speaker("S")]);
  t.mock.timers.tick(250);
  await settleEvents();
  mediaDevices.change([mic("B"), mic("A")]);
  t.mock.timers.tick(250);
  await settleEvents();
  release();
  await settleEvents();
  assert.deepEqual(selections, ["B"]);
});

for (const debounceMs of [0, 250]) {
  test(`a default that switches away and back wins over the interim selection (events spaced ${debounceMs} ms)`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const { ActiveMicRecoveryController } = await import("../../src/helpers/activeMicRecovery.js");
    const mediaDevices = new FakeMediaDevices([mic("A")]);
    const opened = Promise.withResolvers();
    const original = new FakeTrack({ deviceId: "A" });
    const reasons = [];
    const lines = [];
    const record = (level) => (message, meta) => lines.push({ level, message, meta });
    const controller = new ActiveMicRecoveryController({
      mediaDevices,
      acquire: async (reason) => {
        reasons.push(reason);
        if (reasons.length === 1) return opened.promise;
        return new FakeStream(new FakeTrack({ deviceId: mediaDevices.devices[0].deviceId }));
      },
      onRecovered: async () => {},
      logger: { debug: record("debug"), info: record("info"), warn: record("warn") },
    });
    t.after(() => controller.stop());
    await controller.start(new FakeStream(original));
    endTrack(original);
    mediaDevices.change([mic("B"), mic("A")]);
    t.mock.timers.tick(debounceMs);
    await settleEvents();
    const interimSelection = new FakeStream(new FakeTrack({ deviceId: "B" }));
    mediaDevices.change([mic("A"), mic("B")]);
    t.mock.timers.tick(debounceMs);
    await settleEvents();
    opened.resolve(interimSelection);
    await settleEvents();
    assert.deepEqual(reasons, ["ended", "devicechange"]);
    assert.equal(controller.track.getSettings().deviceId, "A");
    // Following the new default is part of the same outage.
    const notable = lines.filter((line) => line.level !== "debug");
    assert.deepEqual(
      notable.map((line) => line.message),
      ["Microphone recovery started", "Microphone recovered"]
    );
    assert.equal(notable[1].meta.durationMs, 2 * debounceMs);
  });
}
