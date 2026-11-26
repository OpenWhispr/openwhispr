const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// The meeting dispatch/start/teardown paths live inside the IPCHandlers
// registration closure, so — like ipcPolicyHeaderCoverage.test.js — this pins
// the wiring at the source level.
const source = fs.readFileSync(path.join(__dirname, "../../src/helpers/ipcHandlers.js"), "utf8");

test("every meeting realtime connect labels the stream and gives system its own VAD threshold", () => {
  assert.match(source, /const MEETING_SYSTEM_VAD_THRESHOLD = 0\.3;/);
  assert.match(
    source,
    /withMeetingSourceConnectOpts = \(connectOpts, source\) => \(\{\s*\.\.\.connectOpts,\s*streamLabel: source,\s*\.\.\.\(source === "system" \? \{ vadThreshold: MEETING_SYSTEM_VAD_THRESHOLD \} : \{\}\),\s*\}\)/
  );
  // Initial connect and mid-meeting reconnect both go through the helper; a
  // bare ...connectOpts spread would silently drop the system channel's
  // threshold and its stream label.
  assert.equal(
    (source.match(/\.\.\.withMeetingSourceConnectOpts\(connectOpts, source\)/g) ?? []).length,
    2
  );
  assert.doesNotMatch(source, /connect\(\{ apiKey: secret, token: secret, \.\.\.connectOpts \}\)/);
});

test("streaming dispatch logs system-channel levels", () => {
  assert.match(
    source,
    /source === "system" && buffer\.length >= 2[\s\S]{0,400}?"Meeting system audio stats"/
  );
});

test("silent system audio warning arms on start and clears on every teardown path", () => {
  // Armed only when a system-audio strategy is active (never for mic-only).
  assert.match(
    source,
    /result\.systemAudioStrategy && result\.systemAudioStrategy !== "unsupported"[\s\S]{0,160}?armMeetingSystemAudioSilenceTimer\(/
  );
  assert.match(source, /send\("meeting-system-audio-silent", \{ systemAudioStrategy \}\)/);
  // Normal/forced stop and error rollback both clear the one-shot timer.
  const rollbackStart = source.indexOf("const rollbackMeetingTranscriptionStart");
  const stopStart = source.indexOf("const stopMeetingTranscription");
  assert.ok(rollbackStart >= 0 && stopStart > rollbackStart);
  const rollbackSection = source.slice(
    rollbackStart,
    source.indexOf("const setupDictationCallbacks")
  );
  assert.match(rollbackSection, /clearMeetingSystemAudioSilenceTimer\(\);/);
  const stopSection = source.slice(
    stopStart,
    source.indexOf("const meetingTranscriptionLifecycle")
  );
  assert.match(stopSection, /clearMeetingSystemAudioSilenceTimer\(\);/);
});

test("a silent Windows capture hands the live session to renderer loopback", () => {
  // probe/activation success cannot see this failure, so the helper's own
  // capture_silent warning is the only trigger back to the Chromium fallback.
  assert.match(
    source,
    /if \(code === "capture_silent"\) \{\s*degradeMeetingSystemAudioToLoopback\(event\);/
  );
  assert.match(
    source,
    /onChunk: \(chunk, nativeClock\) => \{\s*if \(!meetingSystemAudioHandover\.acceptNativeChunk\(chunk\)\) return;/
  );

  // Leaking the latch across sessions would pin the fallback off for the rest
  // of the app's life, so it resets everywhere the heard-audio latch does.
  assert.equal(
    (
      source.match(
        /meetingSystemAudioHeard = false;\s*\n\s*meetingSystemAudioHandover\.reset\(\);/g
      ) ?? []
    ).length,
    2
  );
});

test("the system-audio watchdog is armed beside the silence timer and torn down with it", () => {
  // Same gate as the one-shot warning: never armed for a mic-only session.
  assert.match(
    source,
    /result\.systemAudioStrategy && result\.systemAudioStrategy !== "unsupported"[\s\S]{0,240}?startMeetingSystemAudioWatchdog\(meetingConnectionWin, result\.systemAudioStrategy\)/
  );
  // Only the macOS tap emits a chunk per period, so only it can be judged on
  // delivery gaps; the loopback helpers may legitimately go idle.
  assert.match(source, /watchesDelivery: systemAudioStrategy === "native"/);

  // The ticker is the only timer the controller owns, and leaking one would
  // keep judging a session that has already ended.
  assert.match(
    source,
    /const stopMeetingSystemAudioWatchdog = \(\) => \{[\s\S]{0,400}?clearMeetingSystemAudioTicker\(\);[\s\S]{0,300}?meetingSystemAudioWatchdog\.stop\(\);/
  );

  // Arming runs after capture has started and attached itself, so it must clear
  // only the ticker. Calling the full teardown here detaches the capture the
  // start path just installed, which is how the first draft shipped a watchdog
  // that reported stalls it could not recover from.
  const armStart = source.indexOf("const startMeetingSystemAudioWatchdog");
  assert.ok(armStart >= 0);
  const armSection = source.slice(
    armStart,
    source.indexOf("const rollbackMeetingTranscriptionStart")
  );
  assert.match(armSection, /clearMeetingSystemAudioTicker\(\);/);
  assert.doesNotMatch(armSection, /stopMeetingSystemAudioWatchdog\(\);/);
  assert.doesNotMatch(armSection, /detachCapture\(\)/);

  // Every path that clears the one-shot timer also stops the watchdog, plus the
  // mic-only fallback, which strands the restart hook on a dead manager.
  for (const [label, from, to] of [
    ["rollback", "const rollbackMeetingTranscriptionStart", "const setupDictationCallbacks"],
    ["stop", "const stopMeetingTranscription", "const meetingTranscriptionLifecycle"],
    ["mic-only fallback", "const fallBackToMicOnly", "const startMeetingSystemAudio = async"],
  ]) {
    const start = source.indexOf(from);
    const end = source.indexOf(to);
    assert.ok(start >= 0 && end > start, `${label} section not found`);
    assert.match(source.slice(start, end), /stopMeetingSystemAudioWatchdog\(\);/, label);
  }
});

test("the watchdog sees every system chunk and the helper's device warning", () => {
  // The audible check used to be skipped once the call had been heard, which is
  // exactly the window in which the tap dies (#1990).
  assert.match(
    source,
    /const audible = rms >= MEETING_MIC_SILENCE_RMS \|\| peak >= MEETING_MIC_SILENCE_PEAK;\s*meetingSystemAudioWatchdog\.recordChunk\(audible\);/
  );
  assert.match(
    source,
    /if \(code === "device_invalidated"\) \{\s*meetingSystemAudioWatchdog\.reportDeviceInvalidated\(\);/
  );

  // Recovery bounces the helper process, so the capture must be attached by the
  // same call that started it, not by the arming path.
  const managedStart = source.indexOf("const startManagedMeetingSystemAudio");
  assert.ok(managedStart >= 0);
  const managedSection = source.slice(managedStart, source.indexOf("const fallBackToMicOnly"));
  assert.match(
    managedSection,
    /meetingSystemAudioWatchdog\.attachCapture\(\{\s*stop: \(\) => manager\.stop\(\),\s*start: startCapture,/
  );

  // The interruption reaches the renderer; a log-only warning would leave the
  // user watching a recording that has stopped hearing the call.
  assert.match(source, /send\("meeting-system-audio-interrupted", payload\)/);
});

test("meeting connects forward the credential mode", () => {
  // The Deepgram client picks its Authorization scheme from `mode`; both meeting
  // connectOpts are built by hand, so omitting it re-authenticates Note Recording
  // as managed (#2140). Scoped by sample rate so an unrelated connectOpts cannot
  // drag the assertion off target.
  const connectOptsBlocks =
    source.match(/const connectOpts = \{[^}]*sampleRate: MEETING_STREAM_SAMPLE_RATE,[^}]*\};/g) ??
    [];
  assert.equal(connectOptsBlocks.length, 2, "initial connect and reconnect each build connectOpts");
  for (const block of connectOptsBlocks) {
    // Anchored: an unanchored match also accepts the key commented out.
    assert.match(block, /^\s*mode: options\.mode,$/m);
  }
});

test("a mid-meeting renewal refused for the session reports the sign-in sentinel", () => {
  // The 55-minute renewal and reconnects mint new tokens; a stale session used to
  // reach the toast as the API's bare "Invalid session" (#2427).
  const reconnectCatch = source.slice(
    source.indexOf('debugLogger.error("Meeting stream reconnect failed"'),
    source.indexOf("return canRestoreOld;")
  );
  assert.match(
    reconnectCatch,
    /"meeting-transcription-error",\s*isSignInRefusal\(error\) \? "signInExpired" : error\.message/
  );
});

const meetingDrainHelpers = source.slice(
  source.indexOf("const stopMeetingReconnect ="),
  source.indexOf("const resetMeetingStreamingState =")
);

test("enterprise renewal cannot restore sockets after policy or configuration refusal", async () => {
  const start = source.indexOf("const reconnectMeetingStreams =");
  const end = source.indexOf("const assertMeetingAllowed =", start);
  assert.ok(start >= 0 && end > start);
  for (const code of [
    "PROVIDER_POLICY_CONFLICT",
    "POLICY_UNRESOLVABLE",
    "MANAGED_CONFIG_CHANGED",
    "ECONNRESET",
  ]) {
    let disconnected = 0;
    const streaming = {
      isConnected: true,
      disconnect: async () => disconnected++,
    };
    const system = { ...streaming };
    const target = { _meetingMicStreaming: streaming, _meetingSystemStreaming: system };
    const reconnect = vm.runInNewContext(
      `(function () { ${meetingDrainHelpers} ${source.slice(start, end)} return reconnectMeetingStreams; }).call(target)`,
      {
        target,
        meetingReconnectPromise: null,
        cancelMeetingReconnect: null,
        drainingMeetingStreams: new Map(),
        meetingLocalMode: false,
        meetingConnectionOptions: { provider: "enterprise-realtime" },
        meetingConnectionWin: { isDestroyed: () => false, webContents: { send() {} } },
        meetingReconnectCount: 0,
        meetingReconnectedAt: 0,
        MAX_MEETING_RECONNECTS: 3,
        MEETING_RECONNECT_STABLE_MS: 10000,
        resolveEnterpriseMeetingOptions: async () => {
          throw Object.assign(new Error("replacement refused"), { code });
        },
        debugLogger: { error() {} },
        requeueUnsentMeetingAudio() {},
        resetMeetingReconnectAudio() {},
        meetingReconnectAudioBytes: { mic: 0, system: 0 },
        isSignInRefusal: () => false,
        isAudioPolicyRefusal: () => false,
      }
    );
    const recoverable = code === "ECONNRESET";
    assert.equal(await reconnect({ restoreOldOnFailure: true }), recoverable, code);
    assert.equal(disconnected, recoverable ? 0 : 2, code);
    assert.equal(target._meetingMicStreaming, recoverable ? streaming : null, code);
    assert.equal(target._meetingSystemStreaming, recoverable ? system : null, code);
  }
});

function reconnectHarness(Streaming, options, overrides = {}) {
  const start = source.indexOf("const reconnectMeetingStreams =");
  const end = source.indexOf("const assertMeetingAllowed =", start);
  const disconnect = source.slice(
    source.indexOf("const disconnectMeetingStreaming ="),
    source.indexOf("const clearMeetingSystemAudioSilenceTimer =")
  );
  const target = {
    _meetingMicStreaming: new Streaming(),
    _meetingSystemStreaming: new Streaming(),
  };
  const context = {
    target,
    cancelMeetingReconnect: null,
    drainingMeetingStreams: new Map(),
    resetMeetingStreamingState() {
      target._meetingMicStreaming = null;
      target._meetingSystemStreaming = null;
    },
    meetingReconnectPromise: null,
    meetingLocalMode: false,
    meetingConnectionOptions: options,
    meetingConnectionWin: { isDestroyed: () => false, webContents: { send() {} } },
    meetingConnectionKey: "key",
    meetingReconnectAudioBytes: { mic: 0, system: 0 },
    meetingReplayIncomplete: false,
    MEETING_STOP_REPLAY_TIMEOUT_MS: 100,
    setTimeout,
    clearTimeout,
    meetingReconnectCount: 0,
    meetingReconnectedAt: 0,
    meetingReconnectReplaySources: new Set(),
    MAX_MEETING_RECONNECTS: 3,
    MEETING_RECONNECT_STABLE_MS: 10000,
    MEETING_STREAM_SAMPLE_RATE: 24000,
    credentialGeneration: 0,
    resolveEnterpriseMeetingOptions: async (_event, current) => current,
    enterpriseMeetingConnectOptions: async () => ({}),
    getMeetingConnectionKey: () => "key",
    getMeetingStreamingClient: () => Streaming,
    attachMeetingStreamingHandlers() {},
    fetchRealtimeToken: async (_event, _options, streams) => (streams ? ["k", "k"] : "k"),
    withMeetingSourceConnectOpts: (connectOpts) => connectOpts,
    assertMeetingAllowed() {},
    requeueUnsentMeetingAudio() {},
    replayMeetingReconnectAudio: () => true,
    // A replay empties the queue, as the handler's reset does.
    resetMeetingReconnectAudio() {
      context.meetingReconnectAudioBytes = { mic: 0, system: 0 };
    },
    debugLogger: { error() {}, info() {} },
    isSignInRefusal: () => false,
    isAudioPolicyRefusal: () => false,
    ...overrides,
  };
  const actions = vm.runInNewContext(
    `(function () {
      ${meetingDrainHelpers}
      ${source.slice(start, end)}
      ${disconnect}
      return {reconnect: reconnectMeetingStreams, disconnect: disconnectMeetingStreaming};
    }).call(target)`,
    context
  );
  return { ...actions, target, context };
}

test("reconnects that keep failing right after they succeed run out; ones that hold start over", async () => {
  let now = 100000;
  class Streaming {
    isConnected = false;
    async connect() {
      this.isConnected = true;
    }
    async disconnect() {}
  }
  const { target, reconnect } = reconnectHarness(
    Streaming,
    { provider: "elevenlabs-realtime", mode: "byok" },
    {
      Date: { now: () => now },
    }
  );
  // The provider accepts each handshake, then drops the new sockets a second later.
  const dropAndReconnect = () => {
    now += 1000;
    target._meetingMicStreaming.isConnected = false;
    target._meetingSystemStreaming.isConnected = false;
    return reconnect();
  };

  for (let attempt = 1; attempt <= 3; attempt++) {
    assert.equal(await dropAndReconnect(), true, `attempt ${attempt}`);
  }
  assert.equal(await dropAndReconnect(), false, "the fourth quick failure is not retried");

  // Sockets that stayed up past the stability window earn a fresh set of attempts.
  now += 10000;
  assert.equal(await dropAndReconnect(), true);
});

for (const timing of ["before", "after"]) {
  test(`meeting stop ${timing} the Sarvam replacement handshake closes every socket and drains the original final`, async () => {
    const { EventEmitter } = require("node:events");
    const { SarvamMeetingStreaming } = require("../../src/helpers/sarvamRealtimeStreaming");
    const clients = [];
    class Socket extends EventEmitter {
      send() {}
      close() {
        this.closed = true;
      }
      receive(event) {
        this.emit("message", JSON.stringify(event));
      }
    }
    class Client extends SarvamMeetingStreaming {
      constructor() {
        super(Socket);
        clients.push(this);
      }
    }
    const options = { provider: "sarvam-realtime", model: "saaras:v4", mode: "byok" };
    const { reconnect, disconnect, target } = reconnectHarness(Client, options);
    const original = target._meetingSystemStreaming;
    const ready = original.connect({ ...options, apiKey: "saved" });
    original.ws.receive({ event: "session.begin" });
    await ready;
    original.sendAudio(Buffer.alloc(4800), 1000);
    const finals = [];
    original.onFinalTranscript = (text) => finals.push(text);
    const recovered = reconnect();
    await new Promise(setImmediate);
    const replacements = clients.slice(2);
    assert.equal(replacements.length, 2);
    const finishHandshakes = () => {
      for (const stream of replacements) stream.ws.receive({ event: "session.begin" });
    };
    if (timing === "after") {
      finishHandshakes();
      await recovered;
      assert.equal(target._meetingSystemStreaming, replacements[1]);
    }
    let stopped = false;
    const stopping = disconnect().then(() => {
      stopped = true;
    });
    if (timing === "before") finishHandshakes();
    await recovered;
    await new Promise(setImmediate);
    assert.equal(stopped, false, "the healthy original socket still owes its final");
    assert.ok(replacements.every((stream) => stream.ws.closed && !stream.isConnected));
    original.ws.receive({ event: "transcript.final", utterance_idx: 0, text: "last words" });
    original.ws.receive({ event: "session.end" });
    await stopping;
    assert.deepEqual(finals, ["last words"]);
    assert.equal(original.ws.closed, true);
    assert.equal(target._meetingMicStreaming, null);
    assert.equal(target._meetingSystemStreaming, null);
  });
}

for (const timing of ["ready", "stalled"]) {
  test(`user stop with queued audio gives a ${timing} reconnect a bounded chance to replay`, async () => {
    const gate = Promise.withResolvers();
    const clients = [];
    const sent = [];
    class Client {
      constructor() {
        clients.push(this);
      }
      async connect() {
        await gate.promise;
        this.isConnected = true;
      }
      async disconnect({ commit = true } = {}) {
        this.closed = true;
        this.committed = commit;
      }
    }
    let expire;
    const { reconnect, disconnect } = reconnectHarness(
      Client,
      { provider: "sarvam-realtime" },
      {
        setTimeout: (callback) => {
          expire = callback;
        },
        clearTimeout() {},
        meetingReconnectAudioBytes: { mic: 48000, system: 0 },
        replayMeetingReconnectAudio: (source, client) => {
          if (source === "mic") sent.push(client);
          return true;
        },
      }
    );
    const recovery = reconnect();
    await new Promise(setImmediate);
    const stopping = disconnect({ replayQueued: true });
    await new Promise(setImmediate);
    assert.ok(!clients[2].closed);
    if (timing === "ready") gate.resolve();
    else expire();
    const incomplete = await stopping;
    assert.equal(incomplete, timing === "stalled");
    gate.resolve();
    await recovery;
    assert.deepEqual(sent, timing === "ready" ? [clients[2]] : []);
    assert.ok(clients.every((client) => client.closed));
    assert.equal(clients[2].committed, timing === "ready");
  });
}

test("a user stop whose reconnect was overtaken reports the audio it never replayed", async () => {
  const gate = Promise.withResolvers();
  class Client {
    async connect() {
      await gate.promise;
      this.isConnected = true;
    }
    async disconnect() {
      this.closed = true;
    }
  }
  const replayed = [];
  const { reconnect, disconnect, context } = reconnectHarness(
    Client,
    { provider: "sarvam-realtime" },
    {
      meetingReconnectAudioBytes: { mic: 48000, system: 0 },
      replayMeetingReconnectAudio: (source) => {
        replayed.push(source);
        return true;
      },
    }
  );
  const recovery = reconnect();
  await new Promise(setImmediate);
  const stopping = disconnect({ replayQueued: true });
  await new Promise(setImmediate);
  // The owning window changed, so this reconnect gives up without replaying.
  context.meetingConnectionWin = { isDestroyed: () => false, webContents: { send() {} } };
  gate.resolve();
  assert.equal(await recovery, true);
  assert.equal(await stopping, true, "the queued audio was never transcribed");
  assert.deepEqual(replayed, []);
});

for (const when of ["before token lookup", "during token lookup", "during handshake"]) {
  test(`Sarvam prepare/start refuses a credential replacement ${when}`, async () => {
    let key = "original";
    const gate = Promise.withResolvers();
    const clients = [];
    let reads = 0;
    class Client {
      constructor() {
        clients.push(this);
      }
      async connect() {
        if (when === "during handshake") await gate.promise;
        this.isConnected = true;
      }
      async disconnect() {
        this.closed = true;
      }
    }
    const target = {};
    const start = source.indexOf("const connectRealtimeStreaming =");
    const guard = source.slice(
      source.indexOf("const assertMeetingCredential ="),
      source.indexOf("const resolveEnterpriseMeetingOptions =")
    );
    const code =
      guard + source.slice(start, source.indexOf("// System audio captured in main", start));
    const connect = vm.runInNewContext(
      `(function(){ ${code} return connectRealtimeStreaming; }).call(target)`,
      {
        target,
        changedSarvamCredential: () =>
          Object.assign(new Error("key changed"), { code: "PROVIDER_CREDENTIAL_CHANGED" }),
        getMeetingConnectionKey: () => key,
        getMeetingStreamingClient: () => Client,
        meetingConnectionOptions: null,
        meetingConnectionKey: null,
        BrowserWindow: { fromWebContents: () => ({}) },
        MEETING_STREAM_SAMPLE_RATE: 24000,
        enterpriseMeetingConnectOptions: async () => ({}),
        getMeetingSystemAudioPlan: async () => {
          if (when === "before token lookup") await gate.promise;
          return { mode: "native" };
        },
        fetchRealtimeToken: async () => {
          reads++;
          if (when === "during token lookup") await gate.promise;
          return [key, key];
        },
        attachMeetingStreamingHandlers() {},
        withMeetingSourceConnectOpts: (options) => options,
        assertMeetingAllowed() {},
      }
    );
    const ready = connect(
      { sender: {} },
      { provider: "sarvam-realtime", mode: "byok" },
      undefined,
      key
    );
    await new Promise(setImmediate);
    key = "changed";
    gate.resolve();
    await assert.rejects(ready, { code: "PROVIDER_CREDENTIAL_CHANGED" });
    assert.equal(reads, when === "before token lookup" ? 0 : 1);
    assert.equal(clients.length, when === "during handshake" ? 2 : 0);
    assert.ok(clients.every((client) => client.closed));
  });
}

for (const when of ["before reconnect", "during token lookup", "during handshake"]) {
  test(`Sarvam meeting key changed ${when} cannot authenticate or replay the capture under a replacement key`, async () => {
    const gate = Promise.withResolvers();
    const clients = [];
    const replayed = [];
    const policyStops = [];
    let key = when === "before reconnect" ? "changed" : "original";
    let reads = 0;
    class Client {
      constructor() {
        clients.push(this);
      }
      async connect() {
        this.connected = true;
        if (when === "during handshake") await gate.promise;
        this.isConnected = true;
      }
      async disconnect() {
        this.closed = true;
      }
    }
    const { reconnect, target } = reconnectHarness(
      Client,
      { provider: "sarvam-realtime", mode: "byok" },
      {
        meetingConnectionKey: "original",
        getMeetingConnectionKey: () => key,
        fetchRealtimeToken: async () => {
          reads++;
          if (when === "during token lookup") await gate.promise;
          return [key, key];
        },
        replayMeetingReconnectAudio: (source) => {
          replayed.push(source);
          return true;
        },
      }
    );
    target._stopMeetingForPolicy = (reason, _sessionId, auditReason) => {
      policyStops.push([reason, auditReason]);
    };
    const recovery = reconnect();
    await new Promise(setImmediate);
    key = "changed";
    gate.resolve();
    await recovery;
    assert.deepEqual(policyStops, [["sarvamCredentialChanged", "error"]]);
    assert.deepEqual(replayed, []);
    assert.equal(reads, when === "before reconnect" ? 0 : 1);
    assert.ok(clients.slice(2).every((client) => client.closed || !client.connected));
    if (when !== "during handshake") assert.ok(clients.every((client) => !client.connected));
  });
}

test("a late token refusal from a stopped reconnect cannot end the next meeting", async () => {
  const token = Promise.withResolvers();
  class Client {
    async disconnect() {}
  }
  const { target, reconnect, disconnect } = reconnectHarness(
    Client,
    { provider: "enterprise-realtime" },
    {
      fetchRealtimeToken: () => token.promise,
      isAudioPolicyRefusal: () => true,
    }
  );
  const policyStops = [];
  target._stopMeetingForPolicy = (reason) => policyStops.push(reason);
  const recovery = reconnect();
  await new Promise(setImmediate);
  await disconnect();
  const replacement = new Client();
  target._meetingMicStreaming = replacement;
  token.reject(
    Object.assign(new Error("old meeting no longer allowed"), { code: "POLICY_UNRESOLVABLE" })
  );
  await recovery;
  assert.deepEqual(policyStops, []);
  assert.equal(target._meetingMicStreaming, replacement);
});

// Runs the real reconnect with its replay closures. The clients it connects record
// what they are sent, under the source the meeting attached them for.
function replayHarness({ mic, system }) {
  const start = source.indexOf("const resetMeetingReconnectAudio =");
  const end = source.indexOf("const assertMeetingAllowed =", start);
  const replayed = { mic: [], system: [] };
  class Streaming {
    isConnected = false;
    async connect() {
      this.isConnected = true;
    }
    async disconnect() {}
    sendAudio(buffer, capturedAt) {
      replayed[this.label].push([buffer[0], capturedAt]);
      return true;
    }
  }
  const target = { _meetingMicStreaming: mic, _meetingSystemStreaming: system };
  const closures = vm.runInNewContext(
    `(function () {
      ${meetingDrainHelpers}
      ${source.slice(start, end)}
      return { reconnectMeetingStreams, queueMeetingReconnectAudio };
    }).call(target)`,
    {
      target,
      Buffer,
      cancelMeetingReconnect: null,
      drainingMeetingStreams: new Map(),
      meetingReconnectPromise: null,
      meetingLocalMode: false,
      meetingConnectionOptions: { provider: "elevenlabs-realtime", mode: "byok" },
      meetingConnectionWin: { isDestroyed: () => false, webContents: { send() {} } },
      meetingConnectionKey: null,
      meetingReconnectCount: 0,
      meetingReconnectedAt: 0,
      meetingReconnectAudioBuffers: { mic: [], system: [] },
      meetingReconnectAudioBytes: { mic: 0, system: 0 },
      meetingReconnectReplaySources: new Set(),
      MAX_MEETING_RECONNECTS: 3,
      MEETING_RECONNECT_STABLE_MS: 10000,
      MEETING_RECONNECT_BUFFER_MAX_BYTES: 24000 * 2 * 30,
      MEETING_STREAM_SAMPLE_RATE: 24000,
      MEETING_SYSTEM_VAD_THRESHOLD: 0.3,
      credentialGeneration: 0,
      resolveEnterpriseMeetingOptions: async (_event, current) => current,
      enterpriseMeetingConnectOptions: async () => ({}),
      getMeetingConnectionKey: () => "key",
      getMeetingStreamingClient: () => Streaming,
      attachMeetingStreamingHandlers: (streaming, _win, label) => {
        streaming.label = label;
      },
      fetchRealtimeToken: async (_event, _options, streams) => (streams ? ["k", "k"] : "k"),
      assertMeetingAllowed() {},
      debugLogger: { error() {}, info() {} },
      isSignInRefusal: () => false,
      isAudioPolicyRefusal: () => false,
    }
  );
  return { ...closures, replayed };
}

test("a reconnect replays what its dropped clients never sent ahead of the outage's audio", async () => {
  // ElevenLabs' client queues what it takes, and hands over once what never left.
  const dropped = (...unsent) => ({
    isConnected: false,
    disconnect: async () => {},
    takeUnsentAudio: () => unsent.splice(0),
  });
  const run = replayHarness({
    mic: dropped({ buffer: Buffer.from([1]), capturedAt: 1000 }),
    system: dropped({ buffer: Buffer.from([2]), capturedAt: 2000 }),
  });
  const reconnected = run.reconnectMeetingStreams();
  run.queueMeetingReconnectAudio("mic", Buffer.from([3]), 3000);
  run.queueMeetingReconnectAudio("system", Buffer.from([4]), 4000);
  assert.equal(await reconnected, true);
  assert.deepEqual(run.replayed, {
    mic: [
      [1, 1000],
      [3, 3000],
    ],
    system: [
      [2, 2000],
      [4, 4000],
    ],
  });
});

test("a reconnect leaves the queue of a client that is still connected alone", async () => {
  let asked = false;
  const run = replayHarness({
    mic: { isConnected: false, disconnect: async () => {} },
    system: {
      isConnected: true,
      disconnect: async () => {},
      takeUnsentAudio: () => {
        asked = true;
        return [];
      },
    },
  });
  assert.equal(await run.reconnectMeetingStreams(), true);
  assert.equal(asked, false, "its stop still has that queue to send");
});

test("a reconnect takes nothing from a dropped client that queues nothing", async () => {
  // The other providers' clients send what they take, and have no queue to hand over.
  const run = replayHarness({
    mic: { isConnected: false, disconnect: async () => {} },
    system: null,
  });
  const reconnected = run.reconnectMeetingStreams();
  run.queueMeetingReconnectAudio("mic", Buffer.from([3]), 3000);
  assert.equal(await reconnected, true);
  assert.deepEqual(run.replayed.mic, [[3, 3000]]);
});

test("a reconnect refused under org policy ends the meeting instead of restoring old sockets", () => {
  const reconnectCatch = source.slice(
    source.indexOf('debugLogger.error("Meeting stream reconnect failed"'),
    source.indexOf("return canRestoreOld;")
  );
  assert.match(
    reconnectCatch,
    /if \(isAudioPolicyRefusal\(error\)\) \{\s*this\._stopMeetingForPolicy\(error\.code\);\s*return true;/
  );
  assert.match(
    source,
    /this\._stopMeetingForPolicy = \(reason = "policyRestricted", expectedSessionId, auditReason\) => \{[\s\S]{0,900}?meetingConnectionOptions = null;[\s\S]{0,900}?broadcastToWindows\("meeting-transcription-error", reason\)/
  );
});
