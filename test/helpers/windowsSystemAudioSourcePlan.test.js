const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const createWatchdog = require("../../src/helpers/meetingSystemAudioWatchdog");

// Runs the real access-check, plan and start closures from ipcHandlers.js, the
// way meetingAudioTimeline.test.js does, with only the helper process, the
// window and the platform replaced. #1546: "Default playback device only" must
// reach renderer loopback without touching the helper, and every other value
// must keep today's helper-first path exactly.
const ipcPath = path.join(__dirname, "../../src/helpers/ipcHandlers.js");
const source = fs.readFileSync(ipcPath, "utf8");

function section(from, to) {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `${from} not found in ipcHandlers.js`);
  return source.slice(start, end);
}

async function harness({ platform = "win32", helperAvailable = true, startFails = false } = {}) {
  const sourceHelpers = await import("../../src/helpers/systemAudioSource.js");
  const calls = { capability: [], start: 0, stop: 0 };
  const sent = [];
  const handlers = new Map();
  let onWarning = null;
  const context = {
    ...sourceHelpers,
    process: { platform },
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), on() {} },
    BrowserWindow: {
      fromWebContents: () => ({
        isDestroyed: () => false,
        webContents: { send: (channel) => sent.push(channel) },
      }),
    },
    debugLogger: { warn() {}, debug() {}, error() {}, info() {} },
    // `this.<manager>` in the closures resolves through the context's global.
    windowsLoopbackAudioManager: {
      getCapability: async (options) => {
        calls.capability.push({ ...options });
        return { available: helperAvailable };
      },
      start: async (callbacks) => {
        calls.start += 1;
        onWarning = callbacks.onWarning;
        if (startFails) throw new Error("helper exited before start");
      },
      stop: async () => {
        calls.stop += 1;
      },
    },
    audioTapManager: {
      isSupported: () => platform === "darwin",
      checkAccess: () => ({ granted: true, status: "granted" }),
    },
    linuxPortalAudioManager: {
      getCapability: async () => ({
        available: true,
        supportsSystemAudio: true,
        supportsNativeCapture: true,
        portalVersion: 5,
      }),
    },
    meetingSystemAudioWatchdog: createWatchdog({}),
    meetingSystemAudioDegraded: false,
    meetingSystemAudioHeard: false,
    sendMeetingAudio() {},
  };
  const closures = [
    ["const buildSystemAudioAccess =", 'ipcMain.handle("request-system-audio-access"'],
    ["const getMeetingSystemAudioCapabilityMode =", "const hasNativeMeetingSystemAudio ="],
    ["const degradeMeetingSystemAudioToLoopback =", "const stopMeetingTranscription ="],
  ].map(([from, to]) => section(from, to));
  vm.createContext(context);
  vm.runInContext(
    `
    ${closures.join("\n")}
    globalThis.plan = getMeetingSystemAudioPlan;
    globalThis.startSystemAudio = (strategy) =>
      startMeetingSystemAudio({ sender: {} }, "loopback", strategy, "in realtime mode");
    `,
    context
  );
  // Objects built inside the vm carry its own Object.prototype, which
  // deepStrictEqual rejects, so results are copied into this realm.
  const handler = handlers.get("check-system-audio-access");
  return {
    calls,
    sent,
    check: async (options) => ({ ...(await handler({ sender: {} }, options)) }),
    plan: async (options) => ({ ...(await context.plan(options)) }),
    startSystemAudio: async (strategy) => ({ ...(await context.startSystemAudio(strategy)) }),
    warn: (code) => onWarning?.({ code, message: code }),
  };
}

test("default playback device only goes to renderer loopback without the helper", async () => {
  const h = await harness();

  const access = await h.check({ systemAudioSource: "default-device" });
  assert.equal(access.mode, "loopback");
  assert.equal(access.strategy, "loopback");
  assert.equal(access.supportsNativeCapture, false);

  const plan = await h.plan({
    refreshWindowsCapability: true,
    systemAudioSource: "default-device",
  });
  assert.deepEqual(plan, { mode: "loopback", strategy: "loopback" });
  assert.deepEqual(await h.startSystemAudio(plan.strategy), {
    systemAudioMode: "loopback",
    systemAudioStrategy: "loopback",
  });

  // Not even a capability probe: the helper never runs for this user.
  assert.deepEqual(h.calls.capability, []);
  assert.equal(h.calls.start, 0);
});

test("every other value keeps the native helper exactly as before", async () => {
  for (const systemAudioSource of [undefined, "all-devices", "virtual-cable"]) {
    const h = await harness();
    const options = systemAudioSource === undefined ? undefined : { systemAudioSource };

    const access = await h.check(options);
    assert.equal(access.strategy, "wasapi-loopback", String(systemAudioSource));
    assert.equal(access.supportsNativeCapture, true);

    const plan = await h.plan({ refreshWindowsCapability: true, systemAudioSource });
    assert.deepEqual(plan, { mode: "loopback", strategy: "wasapi-loopback" });
    assert.deepEqual(h.calls.capability, [{ force: false }, { force: true }]);
    assert.deepEqual(await h.startSystemAudio(plan.strategy), {
      systemAudioMode: "loopback",
      systemAudioStrategy: "wasapi-loopback",
    });
    assert.equal(h.calls.start, 1);
  }
});

test("a missing helper still falls back to renderer loopback", async () => {
  const h = await harness({ helperAvailable: false });

  const access = await h.check({ systemAudioSource: "all-devices" });
  assert.equal(access.strategy, "loopback");
  assert.equal(access.supportsNativeCapture, false);
  assert.deepEqual(await h.plan({ refreshWindowsCapability: true }), {
    mode: "loopback",
    strategy: "loopback",
  });
});

test("a helper that fails to start still hands capture to the renderer", async () => {
  const h = await harness({ startFails: true });

  assert.deepEqual(await h.startSystemAudio("wasapi-loopback"), {
    systemAudioMode: "loopback",
    systemAudioStrategy: "loopback",
  });
});

test("a silent helper capture still hands the call to renderer loopback", async () => {
  const h = await harness();

  await h.startSystemAudio("wasapi-loopback");
  h.warn("capture_silent");
  await new Promise(setImmediate);

  assert.deepEqual(h.sent, ["meeting-system-audio-degraded"]);
  assert.equal(h.calls.stop, 1);
});

test("macOS and Linux ignore the Windows-only choice", async () => {
  const mac = await harness({ platform: "darwin" });
  assert.equal((await mac.check({ systemAudioSource: "default-device" })).strategy, "native");
  assert.deepEqual(await mac.plan({ systemAudioSource: "default-device" }), {
    mode: "native",
    strategy: "native",
  });

  const linux = await harness({ platform: "linux" });
  assert.equal(
    (await linux.check({ systemAudioSource: "default-device" })).strategy,
    "pipewire-loopback"
  );
  assert.deepEqual(await linux.plan({ systemAudioSource: "default-device" }), {
    mode: "loopback",
    strategy: "pipewire-loopback",
  });

  assert.deepEqual([...mac.calls.capability, ...linux.calls.capability], []);
});

test("meeting start plans with the renderer's choice and logs the outcome", () => {
  // startMeetingTranscription needs the whole meeting closure, so its wiring is
  // pinned at the source level like meetingStreamingWiring.test.js.
  const start = section("const startMeetingTranscription = async", "const sendMeetingAudio =");

  assert.match(
    start,
    /const systemAudioSource = normalizeSystemAudioSource\(options\.systemAudioSource\);/
  );
  assert.match(
    start,
    /getMeetingSystemAudioPlan\(\{\s*refreshWindowsCapability: true,\s*systemAudioSource,?\s*\}\)/
  );
  // The log names the choice and the strategy that actually started.
  const log = start.slice(start.indexOf('"Meeting system audio source"'));
  assert.match(
    log,
    /^"Meeting system audio source",\s*\{ systemAudioSource, systemAudioStrategy: result\./
  );
});
