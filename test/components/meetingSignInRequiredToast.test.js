const { createRequire } = require("node:module");
const requireRepo = createRequire(require("node:path").resolve(__dirname, "../../package.json"));
const test = require("node:test");
const assert = require("node:assert/strict");
const React = requireRepo("react");
const { createRoot } = requireRepo("react-dom/client");
const { createRendererServer, installBrowserGlobals, installHookDom, installMicCaptureGlobals } =
  requireRepo("./test/lib/rendererTestHarness");

// A Cloud note recording whose realtime-token request is refused used to toast
// the server's bare "Invalid session" / "Not authenticated" (#2427).

async function startWithResult(t, startResult) {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    delete globalThis.__signInToasts;
    delete globalThis.__signInRequests;
  });
  const noop = () => () => {};
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        checkSystemAudioAccess: async () => ({
          granted: true,
          status: "granted",
          mode: "native",
          strategy: "native",
        }),
        meetingTranscriptionStart: async () => startResult,
        onMeetingSystemAudioInterrupted: noop,
        onMeetingSystemAudioResumed: noop,
        onMeetingAutoEndRequested: noop,
      },
    },
  });
  installMicCaptureGlobals(t);
  const container = installHookDom(t);
  globalThis.__signInToasts = [];
  globalThis.__signInRequests = 0;
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-meeting-sign-in-toast-",
    mockModules: {
      "/ui/useToast": `export const useToast = () => ({ toast: (props) => { globalThis.__signInToasts.push(props); return "1"; }, dismiss: () => {} });`,
      "/utils/requestSignIn": `export const requestSignIn = () => { globalThis.__signInRequests += 1; };`,
    },
  });
  const { default: Mount } = await vite.ssrLoadModule("/components/MeetingRecordingMount.tsx");
  const store = await vite.ssrLoadModule("/stores/meetingRecordingStore.ts");
  const { default: i18n } = await vite.ssrLoadModule("/i18n.ts");
  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(Mount)));
  await React.act(async () =>
    store.startRecording({ noteId: null, noteTitle: null, folderId: null, autoEndEligible: false })
  );
  assert.equal(store.useMeetingRecordingStore.getState().isRecording, false);
  assert.equal(globalThis.__signInToasts.length, 1);
  return { toast: globalThis.__signInToasts[0], i18n, store };
}

for (const code of ["AUTH_EXPIRED", "AUTH_REQUIRED"]) {
  test(`${code}: the start failure explains the sign-in and offers it`, async (t) => {
    const { toast, i18n } = await startWithResult(t, {
      success: false,
      error: code === "AUTH_EXPIRED" ? "Invalid session" : "Not authenticated",
      code,
    });

    assert.ok(i18n.exists("notes.meeting.signInRequired"));
    assert.equal(toast.description, i18n.t("notes.meeting.signInRequired"));
    assert.equal(toast.actions.length, 1);
    assert.equal(toast.actions[0].label, i18n.t("common.signIn"));
    toast.actions[0].onClick();
    assert.equal(globalThis.__signInRequests, 1);
  });
}

test("any other start failure keeps its message and offers no sign-in", async (t) => {
  const { toast } = await startWithResult(t, {
    success: false,
    error: "Token request failed: 500",
    status: 500,
  });

  assert.equal(toast.description, "Token request failed: 500");
  assert.equal(toast.actions, undefined);
});

test("a session that expires mid-recording is explained without a Sign in action", async (t) => {
  // Signing in reloads the Control Panel, which would take a running recording with it.
  const { i18n, store } = await startWithResult(t, {
    success: false,
    error: "Token request failed: 500",
    status: 500,
  });
  await React.act(async () =>
    store.useMeetingRecordingStore.setState((state) => ({
      error: "signInExpired",
      errorNonce: state.errorNonce + 1,
    }))
  );

  const toast = globalThis.__signInToasts[1];
  assert.ok(i18n.exists("notes.meeting.signInExpired"));
  assert.equal(toast.description, i18n.t("notes.meeting.signInExpired"));
  assert.equal(toast.actions, undefined);
});
