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

async function mountVoiceConversation(t) {
  const rootRef = { current: null };
  t.after(async () => {
    if (rootRef.current) await React.act(async () => rootRef.current.unmount());
  });

  const calls = { readiness: [], starts: 0, stops: 0, micOpens: 0, micStops: 0, playerCloses: 0 };
  const pending = { readiness: [], start: [], mic: [] };
  const api = {
    isHarness: async () => false,
    brainOverride: async () => null,
    onEvent: () => () => {},
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
          return { parakeetModel: "parakeet-unified-en-0.6b", preferredLanguage: "en" };
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
    hook.current = useVoiceConversation({ onUserTurn: () => {}, onError: () => {} });
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
  return { hook, calls, pending, act, openMic };
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
