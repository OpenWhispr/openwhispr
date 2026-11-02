const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

const managedPolicy = (overrides) => ({
  version: 1,
  transcription: { allowedModes: ["openwhispr", "local"], allowedByokProviders: ["openai"] },
  llm: {
    allowedModes: ["openwhispr", "providers"],
    allowedByokProviders: ["openai"],
    allowedEnterpriseProviders: [],
  },
  features: { agentEnabled: true, webSearchEnabled: true },
  sharing: { externalLinkSharing: "allowed" },
  dataRetention: {
    audioRetentionMaxDays: null,
    localHistoryMode: "user_choice",
    cloudBackupAllowed: true,
  },
  minAppVersion: null,
  ...overrides,
});

test("automatic-start checks use settled auth and live policy after asynchronous work", async (t) => {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  installBrowserGlobals(t);
  const container = installHookDom(t);
  globalThis.__meetingAuth = { isLoaded: false, isSignedIn: false };
  t.after(() => delete globalThis.__meetingAuth);
  const vite = await createRendererServer(t, {
    cachePrefix: "meeting-auto-policy-",
    mockModules: { "./useAuth": "export const useAuth = () => globalThis.__meetingAuth;" },
  });
  const hooks = await vite.ssrLoadModule("/hooks/usePolicy.ts");
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  let allowed;
  let check;
  function Harness() {
    allowed = hooks.useMeetingAutoTranscriptionAllowed();
    check = hooks.useMeetingAutoTranscriptionCheck();
    return null;
  }
  root = createRoot(container);
  const render = () => React.act(async () => root.render(React.createElement(Harness)));
  await render();
  assert.equal(allowed, false);
  assert.equal(check(), false);
  globalThis.__meetingAuth = { isLoaded: true, isSignedIn: false };
  await render();
  assert.equal(allowed, true);
  const pendingCheck = check;
  globalThis.__meetingAuth = { isLoaded: true, isSignedIn: true, isOfflineAccount: true };
  await render();
  assert.equal(pendingCheck(), false);
  await React.act(async () =>
    usePolicyStore.setState({
      status: "managed",
      policy: managedPolicy({ meetings: { transcriptionStart: "automatic" } }),
    })
  );
  assert.equal(allowed, true);
  assert.equal(pendingCheck(), true, "automatic policy still starts");
  // No render is needed between a store update and the pending action's decision.
  await React.act(async () => {
    usePolicyStore.setState({
      policy: managedPolicy({ meetings: { transcriptionStart: "manual" } }),
    });
    assert.equal(pendingCheck(), false);
  });
  assert.equal(allowed, false);
});

test("a recording policy refuses still reports why under automatic policy", async (t) => {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    delete globalThis.__meetingAuth;
  });
  installBrowserGlobals(t);
  const container = installHookDom(t);
  globalThis.__meetingAuth = { isLoaded: true, isSignedIn: true };
  const vite = await createRendererServer(t, {
    cachePrefix: "meeting-auto-refusal-",
    mockModules: { "./useAuth": "export const useAuth = () => globalThis.__meetingAuth;" },
  });
  const hooks = await vite.ssrLoadModule("/hooks/usePolicy.ts");
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  const store = await vite.ssrLoadModule("/stores/meetingRecordingStore.ts");
  const { handleMeetingRecordingRequest } = await vite.ssrLoadModule(
    "/helpers/meetingRecordingRequest.ts"
  );
  let check;
  function Harness() {
    check = hooks.useMeetingAutoTranscriptionCheck();
    return null;
  }
  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(Harness)));
  const snapshots = [
    {
      status: "managed",
      appVersion: "1.0.0",
      policy: managedPolicy({
        minAppVersion: "9.0.0",
        meetings: { transcriptionStart: "automatic" },
      }),
    },
    { status: "error", policy: null },
    { status: "loading", policy: null },
  ];
  for (const snapshot of snapshots) {
    await React.act(async () => usePolicyStore.setState(snapshot));
    assert.equal(check(), true, snapshot.status);
    store.useMeetingRecordingStore.setState({ error: null });
    const calls = [];
    await handleMeetingRecordingRequest({
      args: { noteId: 1, noteTitle: "Meeting", folderId: null, autoEndEligible: true },
      canAutoStart: check,
      startRecording: store.startRecording,
      restoreFromMeetingMode: () => calls.push("restore"),
      onSuppressed: () => calls.push("note-only"),
      onHandled: () => calls.push("handled"),
    });
    assert.deepEqual(calls, ["restore", "handled"], snapshot.status);
    assert.ok(store.useMeetingRecordingStore.getState().error, snapshot.status);
  }
});
