const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const {
  SIGNED_OUT_AUTH_MOCK,
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
  installMicCaptureGlobals,
} = require("../lib/rendererTestHarness");

// The voice draft on the real hook: a take recorded with a fake MediaRecorder
// and transcribed through a stubbed file transcription, so what reaches the
// microphone and the transcription config can be read back. `gate` holds the
// transcription open until it resolves; `agent` mounts the agent window's
// useAgentVoice over it instead.
async function mountVoiceDraft(t, { settings, getUserMedia, gate = null, agent = false }) {
  const bridge = [];
  let root = null;
  // After hooks run in registration order: unmount while the globals exist.
  t.after(() => root && React.act(async () => root.unmount()));
  const transcribed = [];
  globalThis.__voiceDraftTranscribed = transcribed;
  globalThis.__voiceDraftGate = gate;
  t.after(() => {
    delete globalThis.__voiceDraftTranscribed;
    delete globalThis.__voiceDraftGate;
  });
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        saveTempAudio: async () => ({ path: "/tmp/take.webm" }),
        deleteTempAudio: async () => undefined,
        getSystemDefaultMicrophone: async () => null,
        agentWindowSetVoiceState: async (state) => {
          bridge.push(`voice:${state}`);
          return true;
        },
        registerCancelHotkey: async (key) => {
          bridge.push(`esc:${key}`);
          return { success: true };
        },
        unregisterCancelHotkey: async () => {
          bridge.push("esc:off");
          return { success: true };
        },
      },
    },
  });
  const container = installHookDom(t);
  installMicCaptureGlobals(t);
  const opened = [];
  const stream = await navigator.mediaDevices.getUserMedia();
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    opened.push(constraints);
    return getUserMedia(constraints, stream);
  };
  navigator.mediaDevices.enumerateDevices = async () => [
    { kind: "audioinput", deviceId: "default", label: "Default - MacBook Pro Microphone" },
    { kind: "audioinput", deviceId: "usb-mic", label: "USB Mic" },
  ];
  globalThis.MediaRecorder = class FakeMediaRecorder {
    start() {}
    stop() {
      this.ondataavailable({ data: new Blob(["audio"]) });
      this.onstop();
    }
  };
  t.after(() => delete globalThis.MediaRecorder);

  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-voice-draft-test-",
    mockModules: {
      ...SIGNED_OUT_AUTH_MOCK,
      "/hooks/useSettings": `import { useSettingsStore } from "/stores/settingsStore.ts";
        export const useSettings = () => useSettingsStore();`,
      "/services/fileTranscription": `
        export const transcribeFile = async (_path, config) => {
          globalThis.__voiceDraftTranscribed.push(config);
          const text = (await globalThis.__voiceDraftGate) ?? "hello there";
          return { success: true, text };
        };
        export const getTranscriptionApiKey = () => "";
        export const resolveFileTranscriptionRoute = () => ({ transport: "http" });`,
      "/utils/dictationCues":
        "export const playStartCue = async () => {}; export const playStopCue = async () => {};",
    },
  });
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  useSettingsStore.setState(settings);
  const { useVoiceDraft } = await vite.ssrLoadModule("/components/chat/useVoiceDraft.ts");
  const { useAgentVoice } = await vite.ssrLoadModule("/components/agent/useAgentVoice.ts");

  const transcripts = [];
  let voice = null;
  function Harness() {
    voice = agent
      ? useAgentVoice({
          onTranscript: (text, intent) => transcripts.push(`${intent}:${text}`),
          onEmpty: () => transcripts.push("empty"),
          onError: (message) => transcripts.push(`error:${message}`),
          onMicError: (message) => transcripts.push(`mic:${message}`),
        })
      : useVoiceDraft({
          onTranscript: (text) => transcripts.push(text),
          onError: (message) => transcripts.push(`error:${message}`),
          onMicError: (message) => transcripts.push(`mic:${message}`),
        });
    return null;
  }
  const { createRoot } = require("react-dom/client");
  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(Harness)));
  return {
    voice: () => voice,
    opened,
    transcribed,
    transcripts,
    bridge,
    unmount: () => React.act(async () => root.unmount()).then(() => (root = null)),
  };
}

const SIGNED_IN_CLOUD = {
  isSignedIn: true,
  useLocalWhisper: false,
  cloudTranscriptionMode: "openwhispr",
  microphoneSelectionMode: "specific",
  selectedMicDeviceId: "usb-mic",
  selectedMicDeviceLabel: "USB Mic",
};

async function recordTake(harness) {
  let started;
  await React.act(async () => {
    started = await harness.voice().start();
  });
  await React.act(async () => {
    harness.voice().stop();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  return started;
}

test("a signed-in Cloud user's take goes to OpenWhispr Cloud even where no session resolves", async (t) => {
  const harness = await mountVoiceDraft(t, {
    settings: SIGNED_IN_CLOUD,
    getUserMedia: (_constraints, stream) => stream,
  });

  assert.equal(await recordTake(harness), true);
  assert.equal(harness.transcribed.length, 1);
  assert.equal(harness.transcribed[0].isOpenWhisprCloud, true);
  assert.deepEqual(harness.transcripts, ["hello there"]);
});

test("the take records from the chosen microphone with dictation's constraints", async (t) => {
  const harness = await mountVoiceDraft(t, {
    settings: SIGNED_IN_CLOUD,
    getUserMedia: (_constraints, stream) => stream,
  });

  await recordTake(harness);
  assert.deepEqual(harness.opened, [
    {
      audio: {
        deviceId: { exact: "usb-mic" },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 2,
      },
    },
  ]);
});

test("a chosen microphone that won't open falls back to the default one", async (t) => {
  const harness = await mountVoiceDraft(t, {
    settings: SIGNED_IN_CLOUD,
    getUserMedia: (constraints, stream) => {
      if (constraints.audio.deviceId) throw new Error("OverconstrainedError");
      return stream;
    },
  });

  assert.equal(await recordTake(harness), true);
  assert.equal(harness.opened.length, 2);
  assert.equal(harness.opened[1].audio.deviceId, undefined);
  assert.deepEqual(harness.transcripts, ["hello there"]);
});

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test("a take can't start while the last one is still transcribing", async (t) => {
  const transcription = deferred();
  const harness = await mountVoiceDraft(t, {
    settings: SIGNED_IN_CLOUD,
    getUserMedia: (_constraints, stream) => stream,
    gate: transcription.promise,
  });

  assert.equal(await recordTake(harness), true);
  assert.equal(harness.voice().status, "transcribing");
  let second;
  await React.act(async () => {
    second = await harness.voice().start();
  });
  assert.equal(second, false);
  assert.equal(harness.voice().status, "transcribing");

  await React.act(async () => {
    transcription.resolve("first take");
    await settle();
  });
  assert.deepEqual(harness.transcripts, ["first take"]);
  assert.equal(harness.voice().status, "idle");
});

test("cancel abandons a transcription: its text never arrives and the next take can start", async (t) => {
  const transcription = deferred();
  const harness = await mountVoiceDraft(t, {
    settings: SIGNED_IN_CLOUD,
    getUserMedia: (_constraints, stream) => stream,
    gate: transcription.promise,
  });

  await recordTake(harness);
  await React.act(async () => harness.voice().cancel());
  assert.equal(harness.voice().status, "idle");

  let next;
  await React.act(async () => {
    next = await harness.voice().start();
  });
  assert.equal(next, true);

  await React.act(async () => {
    transcription.resolve("abandoned take");
    await settle();
  });
  assert.deepEqual(harness.transcripts, []);
  assert.equal(harness.voice().status, "recording", "the new take keeps recording");
});

test("a microphone that won't open is reported apart from a failed transcription", async (t) => {
  const harness = await mountVoiceDraft(t, {
    settings: SIGNED_IN_CLOUD,
    getUserMedia: () => {
      throw new Error("NotAllowedError");
    },
  });

  let started;
  await React.act(async () => {
    started = await harness.voice().start();
  });
  assert.equal(started, false);
  assert.deepEqual(harness.transcripts, ["mic:NotAllowedError"]);
});

test("the agent's spoken requests expand snippets, like dictation", async (t) => {
  const harness = await mountVoiceDraft(t, {
    settings: {
      ...SIGNED_IN_CLOUD,
      snippets: [{ trigger: "my sig", replacement: "Best, Saket" }],
    },
    getUserMedia: (_constraints, stream) => stream,
    gate: Promise.resolve("sign it with my sig"),
    agent: true,
  });

  let started;
  await React.act(async () => {
    started = await harness.voice().start();
  });
  assert.equal(started, "started");
  await React.act(async () => {
    harness.voice().stop("submit");
    await settle();
  });
  assert.deepEqual(harness.transcripts, ["submit:sign it with Best, Saket"]);
});

test("the agent's Esc belongs to a recording take, and an unmount mid-take frees the mic", async (t) => {
  const transcription = deferred();
  const harness = await mountVoiceDraft(t, {
    settings: SIGNED_IN_CLOUD,
    getUserMedia: (_constraints, stream) => stream,
    gate: transcription.promise,
    agent: true,
  });

  await React.act(async () => {
    await harness.voice().start();
  });
  assert.ok(harness.bridge.includes("esc:Escape"));
  // The take ends (stopped, or its track ended): Esc goes back at once.
  await React.act(async () => {
    harness.voice().stop("submit");
    await settle();
  });
  assert.equal(harness.bridge.at(-1), "voice:transcribing");
  assert.ok(harness.bridge.includes("esc:off"));

  await React.act(async () => {
    transcription.resolve("first take");
    await settle();
  });

  harness.bridge.length = 0;
  await React.act(async () => {
    await harness.voice().start();
  });
  assert.ok(harness.bridge.includes("esc:Escape"));
  await harness.unmount();
  assert.ok(harness.bridge.includes("esc:off"));
  assert.ok(harness.bridge.includes("voice:idle"), "an error screen or reload frees the mic");
});

test("a refused start leaves the transcribing take's intent alone", async (t) => {
  const transcription = deferred();
  const harness = await mountVoiceDraft(t, {
    settings: SIGNED_IN_CLOUD,
    getUserMedia: (_constraints, stream) => stream,
    gate: transcription.promise,
    agent: true,
  });

  await React.act(async () => {
    await harness.voice().start();
  });
  // Keyboard during a take: its text goes to the draft.
  await React.act(async () => {
    harness.voice().stop("draft");
    await settle();
  });
  let second;
  await React.act(async () => {
    second = await harness.voice().start();
  });
  assert.equal(second, "failed");

  await React.act(async () => {
    transcription.resolve("for the draft");
    await settle();
  });
  assert.deepEqual(harness.transcripts, ["draft:for the draft"]);
});
