const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const { audioFeatureFailure } = require("../../src/helpers/audioFeaturePolicy");
const { i18nMain, changeLanguage } = require("../../src/helpers/i18nMain");
const esTranslation = require("../../src/locales/es/translation.json");
const { deferred } = require("../helpers/harness/deferred");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
  installMicCaptureGlobals,
} = require("../lib/rendererTestHarness");

// The 30-second crash-safety save lives in the always-mounted Mount, so it
// keeps running whichever view is open. It writes through the store's
// persistLiveTranscript: the same save the unload flush makes.

const NOTE_ID = 11;
const START_ARGS = {
  noteId: NOTE_ID,
  noteTitle: "Standup",
  folderId: null,
  autoEndEligible: true,
};
const TOAST_MOCK = `
  export const toasts = [];
  const toast = (config) => { toasts.push(config); return "1"; };
  const dismiss = () => {};
  export const useToast = () => ({ toast, dismiss });
`;

async function setup(t, { language = "en" } = {}) {
  let root;
  let store;
  t.after(async () => {
    if (store) await React.act(async () => store.stopRecording());
    if (root) await React.act(async () => root.unmount());
  });
  const listeners = {};
  const capture = (name) => (callback) => {
    listeners[name] = callback;
    return () => {
      if (listeners[name] === callback) listeners[name] = null;
    };
  };
  const noop = () => () => {};
  const writes = [];
  const api = {
    checkSystemAudioAccess: async () => ({
      granted: true,
      status: "granted",
      mode: "native",
      strategy: "native",
    }),
    meetingTranscriptionStart: async () => ({
      success: true,
      systemAudioMode: "native",
      systemAudioStrategy: "native",
    }),
    meetingTranscriptionSetSystemAudioAvailable: async () => ({ success: true }),
    meetingTranscriptionStop: async () => ({ success: true }),
    meetingTranscriptionSend() {},
    updateNote: async (id, patch) => {
      writes.push([id, patch]);
      return { success: true };
    },
    onMeetingTranscriptionSegment: capture("segment"),
    onNoteDeleted: capture("noteDeleted"),
    onMeetingSpeakerIdentified: noop,
    onMeetingSpeakersMerged: noop,
    onMeetingSessionSpeakerConfigUpdated: noop,
    onMeetingTranscriptionError: capture("transcriptionError"),
    onMeetingTranscriptionFatalError: noop,
    onMeetingSystemAudioSilent: noop,
    onMeetingAutoEndRequested: noop,
  };
  installBrowserGlobals(t, {
    initialStorage: { uiLanguage: language },
    window: { electronAPI: api, setTimeout: (fn, ms) => setTimeout(fn, ms) },
  });
  installMicCaptureGlobals(t);
  const container = installHookDom(t);
  globalThis.document.visibilityState = "visible";
  globalThis.document.hasFocus = () => true;
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-meeting-mount-saver-test-",
    mockModules: { "/ui/useToast": TOAST_MOCK },
  });
  const { default: Mount } = await vite.ssrLoadModule("/components/MeetingRecordingMount.tsx");
  const { toasts } = await vite.ssrLoadModule("/ui/useToast");
  store = await vite.ssrLoadModule("/stores/meetingRecordingStore.ts");
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  const setPolicy = (policy) => React.act(async () => usePolicyStore.setState(policy));
  t.mock.timers.enable({ apis: ["setInterval"] });
  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(Mount)));

  const start = () => React.act(async () => store.startRecording(START_ARGS));
  const say = (text) =>
    React.act(async () =>
      listeners.segment({ text, source: "mic", type: "final", timestamp: Date.now() })
    );
  const deleteNote = (id) => listeners.noteDeleted?.({ id });
  const tick = (ms) => React.act(async () => t.mock.timers.tick(ms));
  const savedTranscripts = () => writes.filter(([, patch]) => typeof patch.transcript === "string");
  const streamError = (error) => React.act(async () => listeners.transcriptionError?.(error));
  return {
    start,
    say,
    deleteNote,
    tick,
    writes,
    savedTranscripts,
    api,
    toasts,
    store,
    streamError,
    vite,
    setPolicy,
  };
}

test("the 30-second save writes the live transcript while a recording runs", async (t) => {
  const { start, say, tick, writes, savedTranscripts } = await setup(t);
  await start();
  await say("halfway through the meeting");
  writes.length = 0;

  await tick(30_000);

  const saved = savedTranscripts();
  assert.equal(saved.length, 1);
  assert.equal(saved[0][0], NOTE_ID);
  assert.match(saved[0][1].transcript, /halfway through the meeting/);
});

test("the 30-second save skips a note deleted mid-recording", async (t) => {
  const { start, say, deleteNote, tick, writes, savedTranscripts } = await setup(t);
  await start();
  await say("said before the delete");
  deleteNote(NOTE_ID);
  writes.length = 0;

  await tick(30_000);

  assert.deepEqual(savedTranscripts(), [], "a deleted note is not written back");
});

test("a main policy refusal appears in a Spanish meeting-start toast", async (t) => {
  const previousLanguage = i18nMain.language;
  changeLanguage("es");
  t.after(() => changeLanguage(previousLanguage));
  const { start, api, toasts } = await setup(t, { language: "es" });
  api.meetingTranscriptionStart = async () =>
    audioFeatureFailure(
      { success: true, managed: true, policy: { features: { meetingRecordingEnabled: false } } },
      "meeting"
    );

  await start();

  assert.equal(toasts.at(-1)?.description, esTranslation.notes.meeting.recordingDisabledByOrg);
});

test("a server refusal at start is explained by its code, not the API's message", async (t) => {
  const { start, api, toasts } = await setup(t);
  for (const [code, expected] of [
    ["POLICY_MEETING_RECORDING_DISABLED", "Meeting recording is disabled by your organization."],
    ["AUDIO_PURPOSE_REQUIRED", "Meeting transcription is restricted by your organization."],
  ]) {
    api.meetingTranscriptionStart = async () => ({
      success: false,
      code,
      status: 403,
      error: "raw server text",
    });
    await start();
    assert.equal(toasts.at(-1)?.description, expected, code);
  }
});

test("a policy refusal forwarded mid-meeting ends the recording", async (t) => {
  const { start, store, streamError, toasts } = await setup(t);
  await start();
  assert.equal(store.useMeetingRecordingStore.getState().isRecording, true);

  await streamError("POLICY_MEETING_RECORDING_DISABLED");

  assert.equal(toasts.at(-1)?.description, "Meeting recording is disabled by your organization.");
  assert.equal(store.useMeetingRecordingStore.getState().isRecording, false);
});

test("an unavailable managed meeting route appears translated before capture starts", async (t) => {
  const previousLanguage = i18nMain.language;
  changeLanguage("es");
  t.after(() => changeLanguage(previousLanguage));
  const { start, api, toasts, vite } = await setup(t, { language: "es" });
  let starts = 0;
  api.meetingTranscriptionStart = async () => {
    starts += 1;
    return { success: false };
  };
  const { useEnterpriseIdentityStore } = await vite.ssrLoadModule(
    "/stores/enterpriseIdentityStore.ts"
  );
  useEnterpriseIdentityStore.setState({
    accountId: "account-a",
    workspaceId: "workspace-a",
    authGeneration: 1,
    status: "ready",
    config: {
      generation: 1,
      providers: [
        {
          provider: "openai-compatible",
          mode: "managed_required",
          allowManualSetup: false,
          version: 1,
          config: { realtime: { defaultDeployment: " " } },
        },
      ],
    },
  });

  await start();

  assert.equal(starts, 0);
  assert.equal(toasts.at(-1)?.description, esTranslation.enterprise.audio.operationUnavailable);
});

const MANAGED_SCOPE = {
  allowedModes: ["openwhispr", "providers", "local", "self-hosted", "enterprise"],
  allowedByokProviders: [],
  allowedEnterpriseProviders: [],
};
const managedPolicy = (features) => ({
  status: "managed",
  appVersion: "1.11.0",
  policy: {
    version: 1,
    transcription: MANAGED_SCOPE,
    llm: MANAGED_SCOPE,
    features,
    sharing: { externalLinkSharing: "allowed" },
    dataRetention: {
      localHistoryMode: "user_choice",
      cloudBackupAllowed: true,
      audioRetentionMaxDays: null,
    },
    requiredLocalModels: [],
    minAppVersion: null,
  },
});
// A policy stop from this window explains itself once its stop has finished.
const settle = async (store) => {
  for (let i = 0; i < 100 && store.useMeetingRecordingStore.getState().isRecording; i++) {
    await React.act(() => new Promise((resolve) => setTimeout(resolve, 10)));
  }
  await React.act(() => new Promise((resolve) => setTimeout(resolve, 50)));
};

test("an org's meeting switch refuses a start with its own reason", async (t) => {
  const { start, store, toasts, setPolicy } = await setup(t);
  await setPolicy(managedPolicy({ meetingRecordingEnabled: false }));

  await start();

  assert.equal(store.useMeetingRecordingStore.getState().isRecording, false);
  assert.equal(toasts.at(-1)?.description, "Meeting recording is disabled by your organization.");
});

test("a policy this window can't resolve mid-meeting stops the recording and says so once", async (t) => {
  const { start, store, toasts, setPolicy } = await setup(t);
  await start();
  const before = toasts.length;

  await setPolicy({ status: "error", policy: null });
  await settle(store);

  assert.equal(store.useMeetingRecordingStore.getState().isRecording, false);
  assert.deepEqual(
    toasts.slice(before).map((toast) => toast.description),
    ["Recording stopped because your organization's settings couldn't be checked."]
  );
});

test("main's refusal and this window's policy stop explain the same recording once", async (t) => {
  const { start, store, streamError, toasts, setPolicy } = await setup(t);
  await start();
  const before = toasts.length;

  await streamError("POLICY_MEETING_RECORDING_DISABLED");
  await setPolicy(managedPolicy({ meetingRecordingEnabled: false }));
  await settle(store);

  assert.equal(store.useMeetingRecordingStore.getState().isRecording, false);
  assert.deepEqual(
    toasts.slice(before).map((toast) => toast.description),
    ["Meeting recording is disabled by your organization."]
  );
});

test("main ending a meeting it can no longer check reads as a stop, not a retry", async (t) => {
  const { start, store, streamError, toasts } = await setup(t);
  await start();

  await streamError("POLICY_UNRESOLVABLE");

  assert.equal(store.useMeetingRecordingStore.getState().isRecording, false);
  assert.equal(
    toasts.at(-1)?.description,
    "Recording stopped because your organization's settings couldn't be checked."
  );
});

test("a policy flip while the user's own Stop is finishing adds no policy toast", async (t) => {
  const { start, store, api, toasts, setPolicy } = await setup(t);
  await start();
  const reply = deferred();
  const stop = api.meetingTranscriptionStop;
  api.meetingTranscriptionStop = async (...args) => {
    await reply.promise;
    return stop(...args);
  };
  const before = toasts.length;

  const userStop = store.stopRecording();
  await setPolicy({ status: "error", policy: null });
  reply.resolve();
  await React.act(() => userStop);
  await settle(store);

  assert.deepEqual(toasts.slice(before), []);
});

test("a policy flip that cancels a start still in progress says why", async (t) => {
  const { store, api, toasts, setPolicy } = await setup(t);
  const reply = deferred();
  const startMain = api.meetingTranscriptionStart;
  api.meetingTranscriptionStart = async (...args) => {
    await reply.promise;
    return startMain(...args);
  };
  t.after(() => reply.resolve());
  let starting;
  await React.act(async () => {
    starting = store.startRecording(START_ARGS);
    for (let i = 0; i < 20 && !store.useMeetingRecordingStore.getState().isRecording; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  });
  assert.equal(
    store.useMeetingRecordingStore.getState().isRecording,
    true,
    "the start is under way"
  );

  await setPolicy({ status: "error", policy: null });
  reply.resolve();
  await React.act(() => starting);
  await settle(store);

  assert.equal(store.useMeetingRecordingStore.getState().isRecording, false);
  assert.equal(
    toasts.at(-1)?.description,
    "Recording stopped because your organization's settings couldn't be checked."
  );
});
