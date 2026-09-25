const assert = require("node:assert/strict");
const test = require("node:test");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

// A stop (hotkey, Esc) can land while start() is still awaiting readiness, the
// main-process session or the mic. start() used to carry on regardless: the mic
// opened, state went to "listening" and main kept a live session while the hook
// thought it was off, and the next press leaked that mic by overwriting it.

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

async function mountVoiceConversation(t, { settings = {} } = {}) {
  const rootRef = { current: null };
  t.after(async () => {
    if (rootRef.current) await React.act(async () => rootRef.current.unmount());
  });

  const calls = {
    readiness: [],
    starts: 0,
    stops: 0,
    micOpens: 0,
    micStops: 0,
    playerCloses: 0,
    errors: [],
  };
  const events = { emit: () => {} };
  const pending = { readiness: [], start: [], mic: [] };
  const api = {
    isHarness: async () => false,
    brainOverride: async () => null,
    onEvent: (callback) => {
      events.emit = callback;
      return () => {};
    },
    onHarnessDone: () => () => {},
    getReadiness: (request) => {
      calls.readiness.push(request);
      const next = deferred();
      pending.readiness.push(next);
      return next.promise;
    },
    start: () => {
      calls.starts += 1;
      const next = deferred();
      pending.start.push(next);
      return next.promise;
    },
    stop: async () => {
      calls.stops += 1;
      return { stopped: true };
    },
    sendMic: () => {},
    keepModelWarm: async () => {},
    cancelSpeech: async () => {},
    speak: async () => ({}),
    reportTurn: () => {},
    reportTurnEvent: () => {},
  };
  globalThis.__voiceStartStop = {
    settings: {
      localTranscriptionProvider: "nvidia",
      parakeetModel: "parakeet-unified-en-0.6b",
      cohereModel: "cohere-transcribe-03-2026",
      preferredLanguage: "en",
      ...settings,
    },
    startMicStream: () => {
      calls.micOpens += 1;
      const next = deferred();
      pending.mic.push(next);
      return next.promise;
    },
    createPcmPlayer: () => ({
      enqueue() {},
      flush() {},
      isPlaying: () => false,
      close: async () => {
        calls.playerCloses += 1;
      },
    }),
  };
  t.after(() => delete globalThis.__voiceStartStop);

  installBrowserGlobals(t, { window: { electronAPI: { voiceConversation: api } } });
  const container = installHookDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-voice-start-stop-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `
        const t = (key) => key;
        export function useTranslation() { return { t }; }
      `,
      "/stores/settingsStore": `
        export function getSettings() {
          return globalThis.__voiceStartStop.settings;
        }
        export function useSettingsStore(selector) {
          return selector({ voiceConversationEnabled: true });
        }
      `,
      "/utils/logger": `
        export default { info() {}, warn() {}, error() {}, debug() {} };
      `,
      "/helpers/dictationAgentInference.js": `
        export function resolveChatStreamingInference() {
          return { config: { mode: "local", model: "voice-brain" } };
        }
      `,
      "/services/voice/micStream": `
        export function startMicStream(options) {
          return globalThis.__voiceStartStop.startMicStream(options);
        }
      `,
      "/services/voice/pcmPlayer": `
        export function createPcmPlayer(options) {
          return globalThis.__voiceStartStop.createPcmPlayer(options);
        }
      `,
    },
  });
  const { useVoiceConversation } = await vite.ssrLoadModule("/hooks/useVoiceConversation.ts");

  const hook = { current: null };
  function Harness() {
    hook.current = useVoiceConversation({
      onUserTurn: () => {},
      onError: (message) => calls.errors.push(message),
    });
    return null;
  }
  const root = createRoot(container);
  await React.act(async () => root.render(React.createElement(Harness)));
  rootRef.current = root;

  const act = (callback) =>
    React.act(async () => {
      await callback();
      await settle();
    });
  const openMic = () => {
    const mic = {
      stop: async () => {
        calls.micStops += 1;
      },
    };
    return mic;
  };
  const startListening = async () => {
    await act(() => hook.current.toggle());
    await act(() => pending.readiness.at(-1).resolve({ ready: true }));
    await act(() => pending.start.at(-1).resolve({ sampleRate: 24000 }));
    await act(() => pending.mic.at(-1).resolve(openMic()));
  };
  return { hook, calls, pending, act, openMic, events, startListening };
}

test("stop while readiness is pending: the start never opens anything", async (t) => {
  const { hook, calls, pending, act } = await mountVoiceConversation(t);

  await act(() => hook.current.toggle());
  assert.equal(hook.current.state, "starting");
  await act(() => hook.current.stop());
  await act(() => pending.readiness[0].resolve({ ready: true }));

  assert.equal(calls.starts, 0);
  assert.equal(calls.micOpens, 0);
  assert.equal(hook.current.state, "off");
});

test("stop while the main session is starting: that session is stopped once it exists", async (t) => {
  const { hook, calls, pending, act } = await mountVoiceConversation(t);

  await act(() => hook.current.toggle());
  await act(() => pending.readiness[0].resolve({ ready: true }));
  assert.equal(calls.starts, 1);
  await act(() => hook.current.stop());
  const stopsBeforeSessionExisted = calls.stops;
  await act(() => pending.start[0].resolve({ sampleRate: 24000 }));

  assert.equal(calls.stops, stopsBeforeSessionExisted + 1, "the late session is stopped");
  assert.equal(calls.micOpens, 0);
  assert.equal(hook.current.state, "off");
});

test("stop while the mic is opening: the mic is closed, not leaked on the next press", async (t) => {
  const { hook, calls, pending, act, openMic } = await mountVoiceConversation(t);

  await act(() => hook.current.toggle());
  await act(() => pending.readiness[0].resolve({ ready: true }));
  await act(() => pending.start[0].resolve({ sampleRate: 24000 }));
  assert.equal(calls.micOpens, 1);
  await act(() => hook.current.stop());
  await act(() => pending.mic[0].resolve(openMic()));

  assert.equal(calls.micStops, 1, "the late mic is closed");
  assert.equal(calls.playerCloses, 1);
  assert.equal(hook.current.state, "off");

  // The next press starts a fresh session; stopping it closes only its own mic.
  await act(() => hook.current.toggle());
  await act(() => pending.readiness[1].resolve({ ready: true }));
  await act(() => pending.start[1].resolve({ sampleRate: 24000 }));
  await act(() => pending.mic[1].resolve(openMic()));
  assert.equal(hook.current.state, "listening");
  await act(() => hook.current.stop());

  assert.equal(calls.micStops, 2);
  assert.equal(hook.current.state, "off");
});

test("a start cancelled by stop and replaced by a new start leaves the new session alone", async (t) => {
  const { hook, calls, pending, act, openMic } = await mountVoiceConversation(t);

  await act(() => hook.current.toggle());
  await act(() => pending.readiness[0].resolve({ ready: true }));
  await act(() => hook.current.stop());
  await act(() => hook.current.toggle());
  const stopsWithNewStartActive = calls.stops;
  await act(() => pending.start[0].resolve({ sampleRate: 24000 }));

  assert.equal(calls.stops, stopsWithNewStartActive, "the old start must not stop main's session");

  await act(() => pending.readiness[1].resolve({ ready: true }));
  await act(() => pending.start[1].resolve({ sampleRate: 24000 }));
  await act(() => pending.mic[0].resolve(openMic()));
  assert.equal(calls.micOpens, 1);
  assert.equal(hook.current.state, "listening");
});

test("a voice worker crash ends the session and releases the mic", async (t) => {
  const { hook, calls, act, events, startListening } = await mountVoiceConversation(t);
  await startListening();
  assert.equal(hook.current.state, "listening");

  await act(() =>
    events.emit({ type: "error", stage: "worker", message: "voice worker exited (134)" })
  );

  assert.equal(hook.current.state, "off");
  assert.equal(calls.micStops, 1);
  assert.deepEqual(calls.errors, ["voiceConversation.errors.workerStopped"]);
});

test("a turn that ends without speaking goes back to listening and can idle out", async (t) => {
  const { hook, act, events, startListening } = await mountVoiceConversation(t);
  await startListening();

  await act(() =>
    events.emit({
      type: "transcript",
      text: "what's on today",
      speechMs: 900,
      sttMs: 80,
      endedAt: 0,
      endpoint: null,
    })
  );
  assert.equal(hook.current.state, "thinking");
  // A failed or empty answer: the panel reports the response done with nothing spoken.
  await act(() => hook.current.speechTap.onResponseDone());

  assert.equal(hook.current.state, "listening");
});

test("voice turns use the speech model dictation already runs", async (t) => {
  const { hook, calls, act } = await mountVoiceConversation(t, {
    settings: { localTranscriptionProvider: "cohere", parakeetModel: "parakeet-tdt-0.6b-v3" },
  });

  await act(() => hook.current.toggle());

  assert.equal(calls.readiness[0].parakeetModel, "cohere-transcribe-03-2026");
});
