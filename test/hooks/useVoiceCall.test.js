const assert = require("node:assert/strict");
const test = require("node:test");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

// A voice call on the agent window: start/end races (an End can land during any
// await of the start), the turn loop, barge-in, card answers, the claim hold,
// microphone off and the ways a call ends on its own.

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

async function mountVoiceCall(t, { settings = {}, voiceState = true } = {}) {
  const rootRef = { current: null };
  t.after(async () => {
    if (rootRef.current) await React.act(async () => rootRef.current.unmount());
  });

  const calls = {
    readiness: [],
    starts: [],
    stopIds: [],
    micOpens: 0,
    micStops: 0,
    playerCloses: 0,
    voiceStates: [],
    spoken: [],
    prepared: [],
    player: [],
    paused: [],
    held: [],
    cancelledSpeech: [],
    turns: [],
    reports: [],
    languages: [],
    languageSettings: [],
    dropped: 0,
    ended: [],
    transcriptionFailures: 0,
  };
  const events = { emit: () => {} };
  const pending = { readiness: [], start: [], mic: [], speak: [] };
  const state = {
    answersCard: () => false,
    busy: false,
    holdSpeak: false,
    languageHeard: () => true,
  };
  const api = {
    isHarness: async () => false,
    onEvent: (callback) => {
      events.emit = callback;
      return () => {};
    },
    getReadiness: (request) => {
      calls.readiness.push(request);
      const next = deferred();
      pending.readiness.push(next);
      return next.promise;
    },
    start: (options) => {
      calls.starts.push(options);
      const next = deferred();
      pending.start.push(next);
      return next.promise;
    },
    stop: async (sessionId) => {
      calls.stopIds.push(sessionId);
      return { stopped: true };
    },
    sendMic: () => {},
    pauseInput: async (sessionId, paused) => {
      calls.paused.push([sessionId, paused]);
      return true;
    },
    holdReply: (sessionId, held) => calls.held.push([sessionId, held]),
    keepModelWarm: async () => {},
    setLanguage: async (_sessionId, { language }) => {
      calls.languages.push(language);
      return state.languageHeard(language);
    },
    cancelSpeech: async (utteranceId) => {
      calls.cancelledSpeech.push(utteranceId);
      return { cancelled: true };
    },
    prepareSpeech: async (request) => {
      calls.prepared.push(request);
      return { queued: request.texts.length };
    },
    speak: async ({ utteranceId, text, profile }) => {
      calls.spoken.push({ utteranceId, text, profile });
      if (state.holdSpeak) {
        const next = deferred();
        pending.speak.push(next);
        await next.promise;
      }
      return {};
    },
    reportTurn: (report) => calls.reports.push(report),
    reportTurnEvent: () => {},
  };
  globalThis.__voiceCall = {
    settings: {
      localTranscriptionProvider: "nvidia",
      parakeetModel: "parakeet-unified-en-0.6b",
      cohereModel: "cohere-transcribe-03-2026",
      whisperModel: "base",
      selectedMicDeviceId: "",
      uiLanguage: "en",
      isSignedIn: false,
      voiceCallVoice: "aurora",
      voiceCallSpeed: 1.25,
      voiceCallLanguage: "en",
      ...settings,
    },
    startMicStream: () => {
      calls.micOpens += 1;
      const next = deferred();
      pending.mic.push(next);
      return next.promise;
    },
    createPcmPlayer: (options) => {
      calls.playerOptions = options;
      return {
        enqueue() {},
        flush: () => calls.player.push("flush"),
        pause: () => calls.player.push("pause"),
        resume: () => calls.player.push("resume"),
        isPlaying: () => false,
        readLevel: () => 0,
        close: async () => {
          calls.playerCloses += 1;
        },
      };
    },
  };
  // The store's setter: the setting changes, and its subscribers hear it.
  globalThis.__voiceCall.setLanguage = (language) => {
    const previous = globalThis.__voiceCall.settings;
    calls.languageSettings.push(language);
    globalThis.__voiceCall.settings = { ...previous, voiceCallLanguage: language };
    globalThis.__voiceCall.settingsListener?.(globalThis.__voiceCall.settings, previous);
  };
  t.after(() => delete globalThis.__voiceCall);

  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        voiceConversation: api,
        agentWindowSetVoiceState: async (voice, attempt) => {
          calls.voiceStates.push([voice, attempt]);
          return voiceState;
        },
      },
    },
  });
  const container = installHookDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-voice-call-",
    mockModules: {
      "/stores/settingsStore": `
        export function getSettings() {
          return globalThis.__voiceCall.settings;
        }
        export const useSettingsStore = {
          subscribe: (listener) => {
            globalThis.__voiceCall.settingsListener = listener;
            return () => {};
          },
          getState: () => ({
            setVoiceCallLanguage: (language) => globalThis.__voiceCall.setLanguage(language),
          }),
        };
      `,
      "/utils/logger": `
        export default { info() {}, warn() {}, error() {}, debug() {} };
      `,
      "/helpers/dictationAgentInference.js": `
        export function resolveChatStreamingInference() {
          return { config: { mode: "local", model: "voice-brain", provider: "qwen" } };
        }
      `,
      "/services/voice/micStream": `
        export function startMicStream(options) {
          return globalThis.__voiceCall.startMicStream(options);
        }
      `,
      "/services/voice/pcmPlayer": `
        export function createPcmPlayer(options) {
          return globalThis.__voiceCall.createPcmPlayer(options);
        }
      `,
    },
  });
  const { useVoiceCall } = await vite.ssrLoadModule("/components/agent/useVoiceCall.ts");

  const hook = { current: null };
  function Harness() {
    hook.current = useVoiceCall({
      answersCard: (text) => state.answersCard(text),
      onUserTurn: (turn) => calls.turns.push(turn),
      onReplyDropped: () => {
        calls.dropped += 1;
      },
      onEnded: (reason) => calls.ended.push(reason),
      onTranscriptionFailed: () => {
        calls.transcriptionFailures += 1;
      },
      isBusy: () => state.busy,
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
  const openMic = () => ({
    stop: async () => {
      calls.micStops += 1;
    },
    readLevel: () => 0,
  });
  let started;
  const begin = () => act(() => void (started = hook.current.start()));
  const startListening = async () => {
    await begin();
    await act(() => pending.readiness.at(-1).resolve({ ready: true }));
    await act(() => pending.start.at(-1).resolve({ sessionId: 7, sampleRate: 44100 }));
    await act(() => pending.mic.at(-1).resolve(openMic()));
  };
  const say = (text, endedAt = 0) =>
    act(() =>
      events.emit({
        type: "transcript",
        sessionId: 7,
        text,
        speechMs: 900,
        sttMs: 80,
        endedAt,
        endpoint: null,
      })
    );
  // The reply's audio reaches the player: from here the user has heard it.
  const hear = () =>
    act(() =>
      events.emit({
        type: "tts-audio",
        utteranceId: calls.spoken.at(-1).utteranceId,
        chunkIndex: 0,
        samples: new Float32Array(1),
        at: 0,
      })
    );
  const lastTurn = () => calls.turns.at(-1);
  return {
    hook,
    calls,
    pending,
    state,
    act,
    openMic,
    events,
    begin,
    started: () => started,
    startListening,
    say,
    hear,
    lastTurn,
  };
}

const spokenTexts = (calls) => calls.spoken.map(({ text }) => text);

test("an End while readiness is pending: nothing opens, and the mic claim is given back", async (t) => {
  const { hook, calls, pending, act, begin } = await mountVoiceCall(t);

  await begin();
  assert.equal(hook.current.session, "starting");
  await act(() => hook.current.end());
  await act(() => pending.readiness[0].resolve({ ready: true }));

  assert.equal(calls.starts.length, 0);
  assert.equal(calls.micOpens, 0);
  assert.equal(hook.current.session, "off");
  assert.deepEqual(
    calls.voiceStates.map(([voice]) => voice),
    ["recording", "idle"]
  );
});

test("an End while main's session starts: that session is stopped once it exists", async (t) => {
  const { hook, calls, pending, act, begin } = await mountVoiceCall(t);

  await begin();
  await act(() => pending.readiness[0].resolve({ ready: true }));
  await act(() => hook.current.end());
  await act(() => pending.start[0].resolve({ sessionId: 3, sampleRate: 44100 }));

  assert.equal(calls.stopIds.at(-1), 3, "the late session is stopped");
  assert.equal(calls.micOpens, 0);
  assert.equal(hook.current.session, "off");
});

test("an End while the mic opens: the mic is closed, and the next call starts clean", async (t) => {
  const { hook, calls, pending, act, openMic, begin } = await mountVoiceCall(t);

  await begin();
  await act(() => pending.readiness[0].resolve({ ready: true }));
  await act(() => pending.start[0].resolve({ sessionId: 1, sampleRate: 44100 }));
  await act(() => hook.current.end());
  await act(() => pending.mic[0].resolve(openMic()));

  assert.equal(calls.micStops, 1, "the late mic is closed");
  assert.equal(calls.playerCloses, 1);
  assert.equal(hook.current.session, "off");

  await begin();
  await act(() => pending.readiness[1].resolve({ ready: true }));
  await act(() => pending.start[1].resolve({ sessionId: 2, sampleRate: 44100 }));
  await act(() => pending.mic[1].resolve(openMic()));
  assert.equal(hook.current.session, "active");
  await act(() => hook.current.end());
  assert.equal(calls.micStops, 2);
  assert.deepEqual(calls.stopIds.slice(-1), [2]);
});

test("the call's language and speech model preferences reach main", async (t) => {
  const { calls, pending, act, begin } = await mountVoiceCall(t, {
    settings: { voiceCallLanguage: "hi", localTranscriptionProvider: "cohere" },
  });
  await begin();
  assert.equal(calls.readiness[0].language, "hi");
  assert.equal(calls.readiness[0].preferredParakeet, "cohere-transcribe-03-2026");
  assert.equal(calls.readiness[0].preferredWhisper, "base");
  await act(() => pending.readiness[0].resolve({ ready: true }));
  assert.equal(calls.starts[0].language, "hi");
});

test("a refused start keeps its reason for the window and gives the mic back", async (t) => {
  const { hook, calls, pending, act, begin, started } = await mountVoiceCall(t);
  await begin();
  await act(() => pending.readiness[0].resolve({ ready: false, reason: "language-model-missing" }));

  assert.equal(await started(), false);
  assert.equal(hook.current.failure.reason, "language-model-missing");
  assert.equal(hook.current.session, "off");
  assert.equal(calls.voiceStates.at(-1)[0], "idle");
});

test("dictation holding the mic refuses the call before anything is asked of main", async (t) => {
  const { hook, calls, begin } = await mountVoiceCall(t, { voiceState: false });
  await begin();

  assert.equal(hook.current.failure.reason, "mic-busy");
  assert.equal(calls.readiness.length, 0);
  assert.equal(hook.current.session, "off");
});

test("a denied microphone is its own reason, and only this start's session is stopped", async (t) => {
  const { hook, calls, pending, act, begin } = await mountVoiceCall(t);
  await begin();
  await act(() => pending.readiness[0].resolve({ ready: true }));
  await act(() => pending.start[0].resolve({ sessionId: 3, sampleRate: 44100 }));
  await act(() =>
    pending.mic[0].reject(
      Object.assign(new Error("Permission denied"), { name: "NotAllowedError" })
    )
  );

  assert.equal(hook.current.failure.reason, "mic-denied");
  assert.deepEqual(calls.stopIds, [3]);
  assert.equal(hook.current.session, "off");
});

test("a spoken turn is sent with an observer that speaks its reply in the call's voice", async (t) => {
  const { calls, act, startListening, say, lastTurn } = await mountVoiceCall(t);
  await startListening();
  await say("what's on today");

  assert.equal(lastTurn().text, "what's on today");
  assert.equal(lastTurn().replyLanguage, "en");
  await act(() => lastTurn().speech.onText("You have two meetings. The first is at nine. "));
  await act(() => lastTurn().speech.onEnd("complete"));

  assert.deepEqual(spokenTexts(calls), ["You have two meetings.", "The first is at nine."]);
  assert.deepEqual(calls.spoken[0].profile, { voice: "aurora", speed: 1.25, language: "en" });
});

test("Auto answers in the language spoken, and the reply's language picks the voice's", async (t) => {
  const { calls, act, startListening, say, lastTurn } = await mountVoiceCall(t, {
    settings: { voiceCallLanguage: "auto" },
  });
  await startListening();
  await say("¿qué tengo hoy?");

  assert.equal(lastTurn().replyLanguage, null);
  await act(() => lastTurn().speech.onText("Tienes dos reuniones hoy. "));
  assert.equal(calls.spoken[0].profile.language, "es");
});

test("a tool step with nothing said yet is covered by a filler line", async (t) => {
  const { calls, act, startListening, say, lastTurn } = await mountVoiceCall(t);
  await startListening();
  await say("check my calendar");
  await act(() => lastTurn().speech.onToolCalls(["get_calendar_events"]));

  assert.deepEqual(spokenTexts(calls), ["Let me check your calendar."]);
});

test("a long reply is spoken in part, then points to the chat", async (t) => {
  const { calls, act, startListening, say, lastTurn } = await mountVoiceCall(t);
  await startListening();
  await say("list everything");
  await act(() => lastTurn().speech.onText("One. Two. Three. Four. Five. Six. Seven. Eight. "));
  await act(() => lastTurn().speech.onEnd("complete"));

  assert.deepEqual(spokenTexts(calls), [
    "One.",
    "Two.",
    "Three.",
    "Four.",
    "The rest is in the chat.",
  ]);
});

test("text the claim check flags is held, dropped when withdrawn, spoken once backed", async (t) => {
  const { calls, act, startListening, say, lastTurn } = await mountVoiceCall(t);
  await startListening();
  let backed = false;
  const isUnbacked = (text) => !backed && /I've sent/.test(text);

  await say("send it");
  await act(() => lastTurn().speech.onText("Sure. I've sent it. ", isUnbacked));
  assert.deepEqual(spokenTexts(calls), [], "flagged text isn't spoken");
  await act(() => lastTurn().speech.onTextWithdrawn(0));
  // The same check reads the answer without the withdrawn claim.
  await act(() => lastTurn().speech.onText("I haven't sent it yet. ", isUnbacked));
  await act(() => lastTurn().speech.onEnd("complete"));
  assert.deepEqual(spokenTexts(calls), ["I haven't sent it yet."]);

  await say("send the other one");
  await act(() => lastTurn().speech.onText("I've sent it. ", isUnbacked));
  backed = true;
  await act(() => lastTurn().speech.onEnd("complete"));
  assert.equal(spokenTexts(calls).at(-1), "I've sent it.", "a backed claim is spoken at the end");
});

test("talking over a reply pauses it; noise lets it go on; words stop it and its turn", async (t) => {
  const { calls, act, events, startListening, say, hear, lastTurn } = await mountVoiceCall(t);
  await startListening();
  await say("tell me a long story");
  const story = lastTurn();
  await act(() => story.speech.onText("Once upon a time. "));
  await hear();

  await act(() => events.emit({ type: "speech-start", sessionId: 7, at: 0 }));
  assert.deepEqual(calls.player, ["pause"]);
  await say("");
  assert.deepEqual(calls.player, ["pause", "resume"]);
  assert.equal(calls.dropped, 0, "a cough doesn't cancel the reply");

  await act(() => events.emit({ type: "speech-start", sessionId: 7, at: 0 }));
  await say("stop, that's enough");
  assert.equal(calls.dropped, 1, "words interrupt it for real");
  assert.equal(calls.player.at(-1), "flush");
  assert.equal(lastTurn().text, "stop, that's enough");
  // The old reply's late text is never spoken.
  await act(() => story.speech.onText("The end. "));
  assert.deepEqual(spokenTexts(calls), ["Once upon a time."]);
});

test("words said before any of the reply was heard go on with the request they follow", async (t) => {
  const { calls, act, events, startListening, say, lastTurn } = await mountVoiceCall(t);
  await startListening();
  await say("Create a note titled Groceries with the text", 100);
  await act(() => lastTurn().speech.onText("Done. "));
  // One word (a laugh, "okay") before the reply's audio is no request: the reply goes on.
  await act(() => events.emit({ type: "speech-start", sessionId: 7, at: 200 }));
  await say("Ha.", 300);
  assert.equal(calls.turns.length, 1);
  assert.equal(calls.dropped, 0);

  await act(() => events.emit({ type: "speech-start", sessionId: 7, at: 400 }));
  await say("milk and eggs.", 500);
  assert.equal(calls.turns.length, 2);
  assert.equal(calls.dropped, 1, "the first half's turn stops");
  assert.equal(lastTurn().text, "milk and eggs.", "the chat shows what was said");
  assert.deepEqual(
    calls.turns.map((turn) => turn.joinedRequest),
    [null, "Create a note titled Groceries with the text milk and eggs."],
    "the model answers the request whole"
  );
});

test("words after a turn that called a tool are their own request, never joined onto it", async (t) => {
  const { calls, act, events, startListening, say, lastTurn } = await mountVoiceCall(t);
  await startListening();
  await say("Create a note called Ideas.", 100);
  await act(() => lastTurn().speech.onToolCalls(["create_note"]));
  await act(() => events.emit({ type: "speech-start", sessionId: 7, at: 200 }));
  await say("Put build a treehouse in it.", 300);

  assert.equal(calls.dropped, 1);
  assert.equal(lastTurn().text, "Put build a treehouse in it.");
  assert.equal(lastTurn().joinedRequest, null, "a note it may have created isn't asked for again");
});

test("a reply waits while the user, already talking again, finishes the request", async (t) => {
  const { calls, act, events, startListening, say, lastTurn } = await mountVoiceCall(t);
  await startListening();
  // Speech started again after the first half ended, before its transcript arrived.
  await act(() => events.emit({ type: "speech-start", sessionId: 7, at: 200 }));
  await say("Count from one to thirty,", 100);
  assert.deepEqual(calls.player, ["pause"], "its reply is held from the start");

  await say("saying each number as its own sentence.", 300);
  assert.equal(
    lastTurn().joinedRequest,
    "Count from one to thirty, saying each number as its own sentence."
  );
});

test("a reply that writes out an email draft says only what follows it", async (t) => {
  const { calls, act, startListening, say, lastTurn } = await mountVoiceCall(t);
  await startListening();
  await say("Send an email to Bob telling him I will be late today.");
  const turn = lastTurn();
  await act(() =>
    turn.speech.onText(
      "To: Bob <bob@example.com>\nSubject: Running Late Today\n\nHi Bob,\n\nI'll be late today.\n\nThanks.\n\nConnect your email integration and I can send this for you."
    )
  );
  await act(() => turn.speech.onEnd("complete"));

  assert.deepEqual(spokenTexts(calls), [
    "Connect your email integration and I can send this for you.",
  ]);
});

test("words that answer a waiting question go to the card, and its turn goes on speaking", async (t) => {
  const { calls, state, act, startListening, say, lastTurn } = await mountVoiceCall(t);
  await startListening();
  await say("write a headline");
  const turn = lastTurn();
  await act(() => turn.speech.onText("What tone do you want? "));
  const answered = [];
  state.answersCard = (text) => {
    answered.push(text);
    return true;
  };

  await say("warm and friendly");
  assert.deepEqual(answered, ["warm and friendly"]);
  assert.equal(calls.turns.length, 1, "no new request");
  assert.equal(calls.dropped, 0);
  await act(() => turn.speech.onText("Say what you mean. "));
  assert.equal(spokenTexts(calls).at(-1), "Say what you mean.");
});

test("Stop ends only the reply: the call keeps listening", async (t) => {
  const { hook, calls, act, startListening, say, lastTurn } = await mountVoiceCall(t);
  await startListening();
  await say("tell me something");
  await act(() => lastTurn().speech.onText("Here is a fact. "));
  await act(() => hook.current.stopReply());

  assert.equal(calls.dropped, 1);
  assert.equal(calls.cancelledSpeech.length, 1);
  assert.equal(hook.current.session, "active");
});

test("microphone off releases the device and pauses input; on reopens it", async (t) => {
  const { hook, calls, pending, act, openMic, startListening } = await mountVoiceCall(t);
  await startListening();

  await act(() => hook.current.setMicMuted(true));
  assert.equal(hook.current.micMuted, true);
  assert.equal(calls.micStops, 1);
  assert.deepEqual(calls.paused.at(-1), [7, true]);

  await act(() => void hook.current.setMicMuted(false));
  await act(() => pending.mic.at(-1).resolve(openMic()));
  assert.equal(calls.micOpens, 2);
  assert.deepEqual(calls.paused.at(-1), [7, false]);
  assert.equal(hook.current.session, "active");
});

test("a card asking for a secret pauses input without turning the microphone off", async (t) => {
  const { hook, calls, act, startListening } = await mountVoiceCall(t);
  await startListening();

  await act(() => hook.current.setInputHeld(true));
  assert.deepEqual(calls.paused.at(-1), [7, true]);
  assert.equal(hook.current.micMuted, false);
  assert.equal(calls.micStops, 0);
});

test("a worker crash, a meeting or a long quiet ends the call and says why", async (t) => {
  const { hook, calls, act, events, startListening } = await mountVoiceCall(t);
  await startListening();
  await act(() => events.emit({ type: "error", stage: "worker", message: "exited (134)" }));
  assert.equal(hook.current.session, "off");
  assert.equal(calls.micStops, 1);
  assert.equal(calls.voiceStates.at(-1)[0], "idle");

  await startListening();
  await act(() => events.emit({ type: "ended", reason: "meeting" }));
  assert.deepEqual(calls.ended, ["worker", "meeting"]);
});

test("a quiet call stops after 2.5 minutes, but not while a card or a reply runs", async (t) => {
  const { hook, calls, state, act, startListening } = await mountVoiceCall(t);
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 0 });
  await startListening();

  state.busy = true;
  await act(() => t.mock.timers.tick(200_000));
  assert.equal(hook.current.session, "active", "something in progress keeps the call");

  state.busy = false;
  await act(() => t.mock.timers.tick(150_000));
  assert.equal(hook.current.session, "off");
  assert.deepEqual(calls.ended, ["idle"]);
});

test("using the call's window keeps a quiet call from idling out", async (t) => {
  const { hook, calls, act, startListening } = await mountVoiceCall(t);
  const listeners = new Map();
  globalThis.window.addEventListener = (type, listener) => listeners.set(type, listener);
  globalThis.window.removeEventListener = (type) => listeners.delete(type);
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 0 });
  await startListening();

  await act(() => t.mock.timers.tick(140_000));
  listeners.get("pointerdown")();
  await act(() => t.mock.timers.tick(140_000));
  listeners.get("keydown")();
  await act(() => t.mock.timers.tick(140_000));
  assert.equal(hook.current.session, "active", "a click or a key in its settings is activity");

  await act(() => t.mock.timers.tick(10_000));
  assert.deepEqual(calls.ended, ["idle"]);
  assert.equal(listeners.size, 0, "the ended call stops listening to the window");
});

test("a call prepares the lines it says while working, in its language and voice", async (t) => {
  const { calls, startListening } = await mountVoiceCall(t, {
    settings: { voiceCallLanguage: "de" },
  });
  await startListening();

  const [prepared] = calls.prepared;
  assert.ok(prepared.texts.includes("Ich sehe in deinen Kalender."));
  assert.deepEqual(prepared.profile, { voice: "aurora", speed: 1.25, language: "de" });
});

test("a failed transcription is reported and lets a paused reply go on", async (t) => {
  const { calls, act, events, startListening, say } = await mountVoiceCall(t);
  await startListening();
  await say("tell me a story");
  await act(() => events.emit({ type: "speech-start", sessionId: 7, at: 0 }));
  await act(() => events.emit({ type: "error", stage: "stt", message: "decode failed" }));

  assert.equal(calls.transcriptionFailures, 1);
  assert.deepEqual(calls.player, ["pause", "resume"]);
});

test("one word over a reply never cancels it, unless it is a stop", async (t) => {
  const { hook, calls, act, startListening, say, hear, lastTurn } = await mountVoiceCall(t);
  await startListening();
  await say("write me a headline");
  await act(() => lastTurn().speech.onText("Here is one idea. "));
  await hear();

  await say("Please.");
  assert.equal(calls.turns.length, 1, "a backchannel isn't a request");
  assert.equal(calls.dropped, 0);

  await say("Stop.");
  assert.equal(calls.turns.length, 1, "a stop isn't a request either");
  assert.equal(calls.dropped, 1, "but it stops the reply and its turn");
  assert.equal(hook.current.session, "active");
});

test("a waiting card is announced as part of the reply, and only while one is spoken", async (t) => {
  const { hook, calls, act, startListening, say } = await mountVoiceCall(t);
  await startListening();
  const question = {
    id: "tone",
    kind: "single",
    prompt: "Which tone do you want?",
    options: [
      { id: "warm", label: "Warm" },
      { id: "formal", label: "Formal" },
      { id: "playful", label: "Playful" },
    ],
  };
  await act(() => hook.current.announce({ question }));
  assert.deepEqual(spokenTexts(calls), [], "no reply, nothing to announce into");

  await say("write a headline");
  await act(() => hook.current.announce({ question }));
  await act(() => hook.current.announce({ awaitsSend: true }));
  await act(() => hook.current.announce({}));
  assert.deepEqual(spokenTexts(calls), [
    "Which tone do you want?",
    "Warm, Formal, or Playful.",
    "It's on your screen. Review it, then press Send.",
    "It's on your screen.",
  ]);
  assert.equal(calls.turns.length, 1);
});

test("a turn dropped before it was sent says so, so the window never sends it", async (t) => {
  const { hook, act, startListening, say, lastTurn } = await mountVoiceCall(t);
  await startListening();
  await say("what's the weather");
  const turn = lastTurn();
  assert.equal(turn.isCurrent(), true);

  await act(() => hook.current.stopReply());
  assert.equal(turn.isCurrent(), false);
});

test("turning the microphone on and off quickly leaves one stream, closed at End", async (t) => {
  const { hook, calls, pending, act, openMic, startListening } = await mountVoiceCall(t);
  await startListening();

  await act(() => void hook.current.setMicMuted(true));
  await act(() => void hook.current.setMicMuted(false));
  await act(() => void hook.current.setMicMuted(true));
  await act(() => void hook.current.setMicMuted(false));
  const [first, second] = pending.mic.slice(-2);
  await act(() => first.resolve(openMic()));
  await act(() => second.resolve(openMic()));
  await act(() => hook.current.end());

  assert.equal(calls.micOpens, 3);
  assert.equal(calls.micStops, 3, "every stream opened is stopped");
});

test("a reply paused for the user's speech goes on when nothing can be heard", async (t) => {
  const { hook, calls, act, events, startListening, say } = await mountVoiceCall(t);
  await startListening();
  await say("tell me a story");
  await act(() => events.emit({ type: "speech-start", sessionId: 7, at: 0 }));
  assert.deepEqual(calls.player.slice(-1), ["pause"]);

  await act(() => hook.current.setMicMuted(true));
  assert.deepEqual(calls.player.slice(-1), ["resume"], "microphone off");

  await act(() => void hook.current.setMicMuted(false));
  await act(() => events.emit({ type: "speech-start", sessionId: 7, at: 0 }));
  await act(() => hook.current.setInputHeld(true));
  assert.deepEqual(calls.player.slice(-1), ["resume"], "a card asking for a secret");
});

test("what an earlier session heard never becomes a turn of this one", async (t) => {
  const { calls, act, events, startListening } = await mountVoiceCall(t);
  await startListening();
  const heard = (sessionId) =>
    act(() =>
      events.emit({
        type: "transcript",
        sessionId,
        text: "hello there",
        speechMs: 900,
        sttMs: 80,
        endedAt: 0,
        endpoint: null,
      })
    );

  await heard(6);
  assert.equal(calls.turns.length, 0);
  await heard(7);
  assert.equal(calls.turns.length, 1);
});

test("a reply stays speaking through the gap while its next chunk synthesizes", async (t) => {
  const { hook, calls, pending, state, act, startListening, say, lastTurn } =
    await mountVoiceCall(t);
  await startListening();
  state.holdSpeak = true;
  await say("tell me two things");
  await act(() => lastTurn().speech.onText("One. Two. Three. "));
  await act(() => calls.playerOptions.onStart());
  assert.equal(hook.current.speaking, true);

  await act(() => calls.playerOptions.onIdle());
  assert.equal(hook.current.speaking, true, "a chunk is still synthesizing");

  await act(() => {
    for (const next of pending.speak) next.resolve();
  });
  assert.equal(hook.current.speaking, false, "nothing left to say until the model writes more");
});

test("a reply reads as speaking from its first chunk sent, through a pause for the user's speech", async (t) => {
  const { hook, calls, pending, state, act, events, startListening, say, lastTurn } =
    await mountVoiceCall(t);
  await startListening();
  state.holdSpeak = true;
  await say("what's the capital of France");
  await act(() => lastTurn().speech.onText("Paris. "));
  await act(() => lastTurn().speech.onEnd("complete"));
  assert.equal(hook.current.speaking, true, "synthesizing, before any audio plays");

  await act(() => events.emit({ type: "speech-start", sessionId: 7, at: 0 }));
  assert.equal(hook.current.speaking, true, "held for the user's speech");
  assert.deepEqual(calls.held, [[7, true]], "main ends a short turn at its first pause");

  await act(() => hook.current.stopReply());
  assert.equal(hook.current.speaking, false);
  assert.deepEqual(calls.held.at(-1), [7, false]);
  for (const next of pending.speak) next.resolve();
});

test("fillers don't count against what a reply may say aloud", async (t) => {
  const { calls, act, startListening, say, lastTurn } = await mountVoiceCall(t);
  await startListening();
  await say("check my calendar and list everything");
  await act(() => lastTurn().speech.onToolCalls(["get_calendar_events"]));
  await act(() => lastTurn().speech.onText("One. Two. Three. Four. Five. "));
  await act(() => lastTurn().speech.onEnd("complete"));

  assert.deepEqual(spokenTexts(calls), [
    "Let me check your calendar.",
    "One.",
    "Two.",
    "Three.",
    "Four.",
    "The rest is in the chat.",
  ]);
});

test("in the harness, every line is a request of its own, never a card's answer", async (t) => {
  const { hook, calls, pending, state, act, say } = await mountVoiceCall(t);
  state.answersCard = () => true;
  await act(() => void hook.current.start({ harness: true }));
  await act(() => pending.readiness.at(-1).resolve({ ready: true }));
  await act(() => pending.start.at(-1).resolve({ sessionId: 7, sampleRate: 44100 }));

  await say("what's the capital of Australia");
  assert.equal(calls.turns.length, 1);
  assert.equal(calls.turns[0].dryRunWrites, true);
});

test("a language no model hears is set back once, without asking main again", async (t) => {
  const { calls, state, act, startListening } = await mountVoiceCall(t);
  await startListening();
  state.languageHeard = (language) => language !== "de";

  await act(() => globalThis.__voiceCall.setLanguage("de"));

  assert.deepEqual(calls.languageSettings, ["de", "en"], "set back to the language heard");
  assert.deepEqual(calls.languages, ["de"], "main kept its recognizer, so it isn't asked again");
});

test("a refused language never undoes one picked after it", async (t) => {
  const { calls, state, act, startListening } = await mountVoiceCall(t);
  await startListening();
  let refuse;
  state.languageHeard = (language) =>
    language === "de" ? new Promise((resolve) => (refuse = () => resolve(false))) : true;

  await act(() => globalThis.__voiceCall.setLanguage("de"));
  await act(() => globalThis.__voiceCall.setLanguage("fr"));
  await act(() => refuse());

  assert.deepEqual(calls.languageSettings, ["de", "fr"]);
  assert.equal(globalThis.__voiceCall.settings.voiceCallLanguage, "fr");
});

test("a turn the engine failed or refused is reported as such, not as spoken", async (t) => {
  const { hook, calls, pending, act, say, lastTurn } = await mountVoiceCall(t);
  await act(() => void hook.current.start({ harness: true }));
  await act(() => pending.readiness.at(-1).resolve({ ready: true }));
  await act(() => pending.start.at(-1).resolve({ sessionId: 7, sampleRate: 44100 }));

  await say("what's on my calendar");
  await act(() => lastTurn().speech.onText("Sorry, the assistant couldn't answer. "));
  await act(() => lastTurn().speech.onEnd("error"));

  assert.equal(calls.reports.at(-1).outcome, "error");
});
