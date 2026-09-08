const { createRequire } = require("node:module");
const requireRepo = createRequire(require("node:path").resolve(__dirname, "../../package.json"));
const test = require("node:test");
const assert = require("node:assert/strict");
const React = requireRepo("react");
const { createRoot } = requireRepo("react-dom/client");
const { createRendererServer, installBrowserGlobals, installHookDom, installMicCaptureGlobals } =
  requireRepo("./test/lib/rendererTestHarness");

async function setup(t) {
  let root;
  let store;
  t.after(async () => {
    if (store) await React.act(async () => store.stopRecording());
    if (root) await React.act(async () => root.unmount());
    delete globalThis.__interruptionToasts;
    delete globalThis.__interruptionDismissals;
  });
  const listeners = {};
  const noop = () => () => {};
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
    onMeetingTranscriptionSegment: noop,
    onMeetingSpeakerIdentified: noop,
    onMeetingSpeakersMerged: noop,
    onMeetingSessionSpeakerConfigUpdated: noop,
    onMeetingTranscriptionError: noop,
    onMeetingTranscriptionFatalError: noop,
    onMeetingSystemAudioSilent: noop,
    onMeetingSystemAudioInterrupted(callback) {
      listeners.interrupted = callback;
      return () => {
        if (listeners.interrupted === callback) listeners.interrupted = null;
      };
    },
    onMeetingSystemAudioResumed(callback) {
      listeners.resumed = callback;
      return () => {
        if (listeners.resumed === callback) listeners.resumed = null;
      };
    },
  };
  installBrowserGlobals(t, { window: { electronAPI: api } });
  installMicCaptureGlobals(t);
  const container = installHookDom(t);
  globalThis.document.visibilityState = "visible";
  globalThis.document.hidden = false;
  let focused = true;
  globalThis.document.hasFocus = () => focused;
  const events = new Map();
  for (const target of [globalThis.window, globalThis.document]) {
    target.addEventListener = (name, callback) => events.set(name, callback);
    target.removeEventListener = (name, callback) => {
      if (events.get(name) === callback) events.delete(name);
    };
  }
  const focus = async (value) => {
    focused = value;
    await React.act(async () => events.get("focus")?.());
  };
  const reveal = async () => {
    globalThis.document.hidden = false;
    globalThis.document.visibilityState = "visible";
    await React.act(async () => events.get("visibilitychange")?.());
  };
  globalThis.__interruptionToasts = [];
  globalThis.__interruptionDismissals = [];
  const vite = await createRendererServer(t, {
    cachePrefix: "pr2040-renderer-warning-review-",
    mockModules: {
      "/ui/useToast": `const toast = (props) => { globalThis.__interruptionToasts.push({ ...props, visibility: globalThis.document.visibilityState }); return String(globalThis.__interruptionToasts.length); }; const dismiss = (id) => globalThis.__interruptionDismissals.push(id); export const useToast = () => ({ toast, dismiss });`,
    },
  });
  const { default: Mount } = await vite.ssrLoadModule("/components/MeetingRecordingMount.tsx");
  store = await vite.ssrLoadModule("/stores/meetingRecordingStore.ts");
  root = createRoot(container);
  const render = async (visible, strict = false) =>
    React.act(async () =>
      root.render(
        visible
          ? strict
            ? React.createElement(React.StrictMode, null, React.createElement(Mount))
            : React.createElement(Mount)
          : null
      )
    );
  await render(true);
  await React.act(async () =>
    store.startRecording({ noteId: null, noteTitle: null, folderId: null, autoEndEligible: false })
  );
  assert.equal(store.useMeetingRecordingStore.getState().isRecording, true);
  const interrupt = async (details = {}) =>
    React.act(async () =>
      listeners.interrupted({
        systemAudioStrategy: "native",
        reason: "no_audio_delivered",
        recovering: false,
        ...details,
      })
    );
  const { default: i18n } = await vite.ssrLoadModule("/i18n.ts");
  const resume = async () => React.act(async () => listeners.resumed?.());
  return { store, render, interrupt, resume, focus, reveal, i18n };
}

test("audio resuming while hidden discards the quiet warning before focus", async (t) => {
  const { interrupt, resume, focus, reveal } = await setup(t);
  globalThis.document.visibilityState = "hidden";
  await focus(false);
  await interrupt({ reason: "gone_quiet" });
  await resume();
  await reveal();
  await focus(true);
  assert.equal(globalThis.__interruptionToasts.length, 0);
});

test("audio resuming with Mount absent clears its pending quiet warning", async (t) => {
  const { render, interrupt, resume } = await setup(t);
  await render(false);
  await interrupt({ reason: "gone_quiet" });
  await resume();
  await render(true);
  assert.equal(globalThis.__interruptionToasts.length, 0);
});

test("audio resuming dismisses a visible quiet warning even after unmount", async (t) => {
  const { render, interrupt, resume } = await setup(t);
  await interrupt({ reason: "gone_quiet" });
  assert.equal(globalThis.__interruptionToasts.length, 1);
  await render(false);
  await resume();
  assert.deepEqual(globalThis.__interruptionDismissals, ["1"]);
  await render(true);
  assert.equal(globalThis.__interruptionToasts.length, 1);
});

test("hidden and covered warnings wait for a focused visible window", async (t) => {
  const { interrupt, focus, reveal } = await setup(t);
  globalThis.document.hidden = true;
  globalThis.document.visibilityState = "hidden";
  await interrupt();
  assert.equal(globalThis.__interruptionToasts.length, 0);
  await focus(false);
  await reveal();
  assert.equal(globalThis.__interruptionToasts.length, 0);
  await focus(true);
  assert.equal(globalThis.__interruptionToasts.length, 1);
  assert.equal(globalThis.__interruptionToasts[0].duration, 0);
});

test("unmounted events deliver once on remount and repeated events replace the warning", async (t) => {
  const { render, interrupt } = await setup(t);
  await render(false);
  await interrupt();
  await render(true);
  assert.equal(globalThis.__interruptionToasts.length, 1);
  await render(true);
  assert.equal(globalThis.__interruptionToasts.length, 1);
  await render(false);
  assert.equal(globalThis.__interruptionDismissals.length, 0);
  await render(true);
  assert.equal(globalThis.__interruptionToasts.length, 1);
  await interrupt();
  assert.equal(globalThis.__interruptionToasts.length, 2);
});

test("persistent warning offers a scoped stop and does not leak into the next session", async (t) => {
  const { store, interrupt, render } = await setup(t);
  await interrupt();
  const warning = globalThis.__interruptionToasts[0];
  assert.equal(warning.duration, 0);
  assert.ok(warning.action);
  await React.act(async () => warning.action.props.onClick());
  assert.equal(store.useMeetingRecordingStore.getState().isRecording, false);
  await React.act(async () =>
    store.startRecording({ noteId: null, noteTitle: null, folderId: null, autoEndEligible: false })
  );
  await React.act(async () => warning.action.props.onClick());
  assert.equal(store.useMeetingRecordingStore.getState().isRecording, true);
  await render(false);
  await render(true);
  assert.equal(globalThis.__interruptionToasts.length, 1);
});

test("stop before returning discards an unseen interruption", async (t) => {
  const { store, interrupt, focus, render } = await setup(t);
  await focus(false);
  await interrupt();
  await React.act(async () => store.stopRecording());
  await focus(true);
  await render(false);
  await render(true);
  assert.equal(globalThis.__interruptionToasts.length, 0);
});

test("latest pending event delivers once and cautious warnings do not offer stop", async (t) => {
  const { interrupt, focus } = await setup(t);
  await focus(false);
  await interrupt();
  await interrupt({ reason: "gone_quiet" });
  await focus(true);
  assert.equal(globalThis.__interruptionToasts.length, 1);
  assert.equal(globalThis.__interruptionToasts[0].title, "Meeting audio has gone quiet");
  assert.equal(globalThis.__interruptionToasts[0].action, undefined);
  await interrupt({ recovering: true });
  assert.deepEqual(globalThis.__interruptionDismissals, ["1"]);
  assert.equal(globalThis.__interruptionToasts[1].title, "Meeting audio interrupted");
  assert.equal(globalThis.__interruptionToasts[1].action, undefined);
  assert.equal(globalThis.__interruptionToasts[1].duration, 8000);
});

test("locale changes do not replay delivered interruptions", async (t) => {
  const { interrupt, i18n } = await setup(t);
  await interrupt();
  try {
    await React.act(async () => i18n.changeLanguage("es"));
    assert.equal(globalThis.__interruptionToasts.length, 1);
  } finally {
    await React.act(async () => i18n.changeLanguage("en"));
  }
});

test("StrictMode does not replay or dismiss a delivered persistent warning", async (t) => {
  const { interrupt, render } = await setup(t);
  await interrupt();
  await render(false);
  await render(true, true);
  assert.equal(globalThis.__interruptionToasts.length, 1);
  assert.equal(globalThis.__interruptionDismissals.length, 0);
});

test("replacement while hidden dismisses the old warning and remains pending", async (t) => {
  const { interrupt, focus } = await setup(t);
  await interrupt();
  await focus(false);
  await interrupt();
  assert.deepEqual(globalThis.__interruptionDismissals, ["1"]);
  assert.equal(globalThis.__interruptionToasts.length, 1);
  await focus(true);
  assert.equal(globalThis.__interruptionToasts.length, 2);
});

test("stopping with Mount absent removes its persistent warning", async (t) => {
  const { store, interrupt, render } = await setup(t);
  await interrupt();
  await render(false);
  await React.act(async () => store.stopRecording());
  assert.deepEqual(globalThis.__interruptionDismissals, ["1"]);
});
