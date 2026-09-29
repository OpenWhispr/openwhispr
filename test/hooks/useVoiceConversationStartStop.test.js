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
    stopIds: [],
    spoken: [],
    prepared: [],
    player: [],
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
    stop: async (sessionId) => {
      calls.stops += 1;
      calls.stopIds.push(sessionId);
      return { stopped: true };
    },
    sendMic: () => {},
    keepModelWarm: async () => {},
    cancelSpeech: async () => {},
    prepareSpeech: async (texts) => {
      calls.prepared.push(...texts);
      return { queued: texts.length };
    },
    speak: async ({ text }) => {
      calls.spoken.push(text);
      return {};
    },
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
      flush: () => calls.player.push("flush"),
      pause: () => calls.player.push("pause"),
      resume: () => calls.player.push("resume"),
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
    await act(() => void hook.current.toggle());
    await act(() => pending.readiness.at(-1).resolve({ ready: true }));
    await act(() => pending.start.at(-1).resolve({ sessionId: 7, sampleRate: 24000 }));
    await act(() => pending.mic.at(-1).resolve(openMic()));
  };
  const say = (text) =>
    act(() =>
      events.emit({
        type: "transcript",
        text,
        speechMs: 900,
        sttMs: 80,
        endedAt: 0,
        endpoint: null,
      })
    );
  return { hook, calls, pending, act, openMic, events, startListening, say };
}

test("stop while readiness is pending: the start never opens anything", async (t) => {
  const { hook, calls, pending, act } = await mountVoiceConversation(t);

  await act(() => void hook.current.toggle());
  assert.equal(hook.current.state, "starting");
  await act(() => hook.current.stop());
  await act(() => pending.readiness[0].resolve({ ready: true }));

  assert.equal(calls.starts, 0);
  assert.equal(calls.micOpens, 0);
  assert.equal(hook.current.state, "off");
});

test("stop while the main session is starting: that session is stopped once it exists", async (t) => {
  const { hook, calls, pending, act } = await mountVoiceConversation(t);

  await act(() => void hook.current.toggle());
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

  await act(() => void hook.current.toggle());
  await act(() => pending.readiness[0].resolve({ ready: true }));
  await act(() => pending.start[0].resolve({ sampleRate: 24000 }));
  assert.equal(calls.micOpens, 1);
  await act(() => hook.current.stop());
  await act(() => pending.mic[0].resolve(openMic()));

  assert.equal(calls.micStops, 1, "the late mic is closed");
  assert.equal(calls.playerCloses, 1);
  assert.equal(hook.current.state, "off");

  // The next press starts a fresh session; stopping it closes only its own mic.
  await act(() => void hook.current.toggle());
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

  await act(() => void hook.current.toggle());
  await act(() => pending.readiness[0].resolve({ ready: true }));
  await act(() => hook.current.stop());
  await act(() => void hook.current.toggle());
  await act(() => pending.start[0].resolve({ sessionId: 1, sampleRate: 24000 }));

  // The old start ends only the session it opened; main ignores it once another is running.
  assert.equal(calls.stopIds.at(-1), 1);

  await act(() => pending.readiness[1].resolve({ ready: true }));
  await act(() => pending.start[1].resolve({ sessionId: 2, sampleRate: 24000 }));
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

  await act(() => void hook.current.toggle());

  assert.equal(calls.readiness[0].parakeetModel, "cohere-transcribe-03-2026");
});

test("talking over an answer pauses it; a sound that transcribes to nothing lets it carry on", async (t) => {
  const { hook, calls, act, events, startListening, say } = await mountVoiceConversation(t);
  await startListening();
  let cancelled = 0;
  await say("tell me a long story");
  hook.current.speechTap.cancelRef.current = () => (cancelled += 1);

  await act(() => events.emit({ type: "speech-start", at: 0 }));
  assert.deepEqual(calls.player, ["pause"]);
  await say("");
  assert.deepEqual(calls.player, ["pause", "resume"]);
  assert.equal(cancelled, 0, "a cough doesn't cancel the answer");

  await act(() => events.emit({ type: "speech-start", at: 0 }));
  await say("stop, that's enough");
  assert.equal(cancelled, 1, "words interrupt it for real");
  assert.equal(calls.player.at(-1), "flush");
});

test("an answer that claims an action no tool took is corrected out loud", async (t) => {
  const { hook, calls, act, startListening, say } = await mountVoiceConversation(t);
  await startListening();
  await say("add Kubernetes to my dictionary");

  await act(() =>
    hook.current.speechTap.onContentDelta("I've added Kubernetes to your dictionary.")
  );
  await act(() => hook.current.speechTap.onResponseDone());

  assert.equal(calls.spoken.at(-1), "Sorry, I didn't actually do that. Want me to try again?");
});

test("a refused start shows the translated reason and reports it never started", async (t) => {
  const { hook, calls, pending, act } = await mountVoiceConversation(t);
  let started;
  await act(() => {
    started = hook.current.toggle();
  });
  await act(() => pending.readiness[0].resolve({ ready: false, reason: "language-unsupported" }));

  assert.equal(await started, false);
  assert.deepEqual(calls.errors, ["voiceConversation.errors.languageUnsupported"]);
  assert.equal(hook.current.state, "off");
});

test("a denied microphone shows a translated message, not the browser's", async (t) => {
  const { hook, calls, pending, act } = await mountVoiceConversation(t);
  await act(() => void hook.current.toggle());
  await act(() => pending.readiness[0].resolve({ ready: true }));
  await act(() => pending.start[0].resolve({ sessionId: 3, sampleRate: 24000 }));
  await act(() =>
    pending.mic[0].reject(
      Object.assign(new Error("Permission denied"), { name: "NotAllowedError" })
    )
  );

  assert.deepEqual(calls.errors, ["voiceConversation.errors.micDenied"]);
  assert.deepEqual(calls.stopIds, [3], "only the session this start opened is stopped");
  assert.equal(hook.current.state, "off");
});

test("stop names the session it ends, so a late stop can't end a newer one", async (t) => {
  const { hook, calls, act, startListening } = await mountVoiceConversation(t);
  await startListening();
  await act(() => hook.current.stop());
  assert.deepEqual(calls.stopIds, [7]);
});

test("an idle session stops after 2.5 minutes, but not while an answer is in progress", async (t) => {
  const { hook, act, startListening, say } = await mountVoiceConversation(t);
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 0 });
  await startListening();

  await say("what's the weather");
  await act(() => t.mock.timers.tick(200_000));
  assert.notEqual(hook.current.state, "off", "a turn in progress keeps the session");

  await act(() => hook.current.speechTap.onResponseDone());
  await act(() => t.mock.timers.tick(150_000));
  assert.equal(hook.current.state, "off");
});

test("a paused answer that ends with nothing to say un-pauses the player for the next one", async (t) => {
  const { hook, calls, act, events, startListening, say } = await mountVoiceConversation(t);
  await startListening();
  await say("what's on today");
  await act(() => events.emit({ type: "speech-start", at: 0 }));
  assert.deepEqual(calls.player, ["pause"]);

  // The answer fails (or is empty) while the user is still talking.
  await act(() => hook.current.speechTap.onResponseDone());

  assert.deepEqual(calls.player, ["pause", "resume"]);
});

test("a meeting recording that takes the mic ends the session with a translated message", async (t) => {
  const { hook, calls, act, events, startListening } = await mountVoiceConversation(t);
  await startListening();

  await act(() => events.emit({ type: "ended", reason: "meeting" }));

  assert.equal(hook.current.state, "off");
  assert.equal(calls.micStops, 1);
  assert.deepEqual(calls.errors, ["voiceConversation.errors.endedForMeeting"]);
});

test("a session prepares the tool filler lines as soon as it is listening", async (t) => {
  const { calls, startListening } = await mountVoiceConversation(t);
  await startListening();

  assert.ok(calls.prepared.includes("Let me check your calendar."));
  assert.ok(calls.prepared.includes("One moment."));
});
