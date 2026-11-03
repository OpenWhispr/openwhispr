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

async function mountCheck(t, cachePrefix, mockModules) {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  installBrowserGlobals(t);
  const container = installHookDom(t);
  const vite = await createRendererServer(t, { cachePrefix, mockModules });
  const hooks = await vite.ssrLoadModule("/hooks/usePolicy.ts");
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  let check;
  function Harness({ auth }) {
    check = hooks.useMeetingAutoTranscriptionCheck(auth);
    return null;
  }
  root = createRoot(container);
  const render = (auth) =>
    React.act(async () => root.render(React.createElement(Harness, { auth })));
  return { vite, usePolicyStore, render, check: () => check };
}

test("automatic-start checks use settled auth and live policy after asynchronous work", async (t) => {
  const { usePolicyStore, render, check } = await mountCheck(t, "meeting-auto-policy-");
  await render({ isLoaded: false, isSignedIn: false });
  assert.equal(check()(), false, "unsettled auth is not evidence of a guest");
  await render({ isLoaded: true, isSignedIn: false });
  assert.equal(check()(), true);
  const pendingCheck = check();
  await render({ isLoaded: true, isSignedIn: true });
  assert.equal(check(), pendingCheck, "the check stays stable across renders");
  assert.equal(pendingCheck(), false, "a signed-in window waits for its policy");
  await React.act(async () =>
    usePolicyStore.setState({
      status: "managed",
      policy: managedPolicy({ meetings: { transcriptionStart: "automatic" } }),
    })
  );
  assert.equal(pendingCheck(), true, "automatic policy still starts");
  // No render is needed between a store update and the pending action's decision.
  usePolicyStore.setState({
    policy: managedPolicy({ meetings: { transcriptionStart: "manual" } }),
  });
  assert.equal(pendingCheck(), false);
});

test("a settled guest's session refetch doesn't lose an automatic start", async (t) => {
  const { render, check } = await mountCheck(t, "meeting-auto-guest-refetch-");
  await render({ isLoaded: true, isSignedIn: false });
  await render({ isLoaded: false, isSignedIn: false });
  assert.equal(check()(), true);
});

test("an account switch still blocks automatic starts until it settles", async (t) => {
  const { render, check, usePolicyStore } = await mountCheck(t, "meeting-auto-account-switch-");
  usePolicyStore.setState({ status: "unmanaged", policy: null });
  await render({ isLoaded: true, isSignedIn: true });
  assert.equal(check()(), true);
  await render({ isLoaded: false, isSignedIn: false });
  assert.equal(check()(), false);
});

test("a credential holder shown as a guest waits for its policy", async (t) => {
  globalThis.__hasCredential = false;
  t.after(() => delete globalThis.__hasCredential);
  const { render, check } = await mountCheck(t, "meeting-auto-credential-", {
    "/lib/authRequestContext":
      "export const hasUsableCredential = () => globalThis.__hasCredential;",
  });
  await render({ isLoaded: true, isSignedIn: false });
  assert.equal(check()(), true, "a real guest has no policy to wait for");
  globalThis.__hasCredential = true;
  assert.equal(check()(), false, "a token not yet bound to a session, or a stale offline profile");
  await render({ isLoaded: false, isSignedIn: false });
  assert.equal(check()(), false, "a sign-in in progress is not a guest's refetch");
  globalThis.__hasCredential = false;
  assert.equal(check()(), true, "a guest's refetch stays settled");
});

test("a recording policy refuses still reports why under automatic policy", async (t) => {
  const { vite, usePolicyStore, render, check } = await mountCheck(t, "meeting-auto-refusal-");
  await render({ isLoaded: true, isSignedIn: true });
  const store = await vite.ssrLoadModule("/stores/meetingRecordingStore.ts");
  const { handleMeetingRecordingRequest } = await vite.ssrLoadModule(
    "/helpers/meetingRecordingRequest.ts"
  );
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
    assert.equal(check()(), true, snapshot.status);
    store.useMeetingRecordingStore.setState({ error: null });
    const calls = [];
    await handleMeetingRecordingRequest({
      args: { noteId: 1, noteTitle: "Meeting", folderId: null, autoEndEligible: true },
      canAutoStart: check(),
      startRecording: store.startRecording,
      restoreFromMeetingMode: () => calls.push("restore"),
      onSuppressed: () => calls.push("note-only"),
      onHandled: () => calls.push("handled"),
    });
    assert.deepEqual(calls, ["restore", "handled"], snapshot.status);
    assert.ok(store.useMeetingRecordingStore.getState().error, snapshot.status);
  }
});

test("manual policy opens the note silently even when a recording would be refused", async (t) => {
  const { vite, usePolicyStore, render, check } = await mountCheck(t, "meeting-manual-refusal-");
  await render({ isLoaded: true, isSignedIn: true });
  const store = await vite.ssrLoadModule("/stores/meetingRecordingStore.ts");
  const { handleMeetingRecordingRequest } = await vite.ssrLoadModule(
    "/helpers/meetingRecordingRequest.ts"
  );
  const { isTranscriptionContextAllowed } = await vite.ssrLoadModule("/stores/policyRules.ts");
  const { getSettings } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const meetings = { transcriptionStart: "manual" };
  const snapshots = {
    "below the minimum version": {
      appVersion: "1.0.0",
      policy: managedPolicy({ meetings, minAppVersion: "9.0.0" }),
    },
    "meeting recording turned off": {
      appVersion: "9.0.0",
      policy: managedPolicy({ meetings, features: { meetingRecordingEnabled: false } }),
    },
    "a disallowed transcription selection": {
      appVersion: "9.0.0",
      policy: managedPolicy({
        meetings,
        transcription: { allowedModes: [], allowedByokProviders: [] },
      }),
    },
    "a start mode this build doesn't know": {
      appVersion: "1.0.0",
      policy: managedPolicy({
        meetings: { transcriptionStart: "future" },
        minAppVersion: "9.0.0",
      }),
    },
  };
  for (const [name, snapshot] of Object.entries(snapshots)) {
    await React.act(async () => usePolicyStore.setState({ status: "managed", ...snapshot }));
    assert.equal(
      isTranscriptionContextAllowed(usePolicyStore.getState(), getSettings(), "meeting"),
      false,
      `${name} must be a recording policy refuses`
    );
    store.useMeetingRecordingStore.setState({ error: null });
    const calls = [];
    await handleMeetingRecordingRequest({
      args: { noteId: 1, noteTitle: "Meeting", folderId: null, autoEndEligible: true },
      canAutoStart: check(),
      startRecording: store.startRecording,
      restoreFromMeetingMode: () => calls.push("restore"),
      onSuppressed: () => calls.push("note-only"),
      onHandled: () => calls.push("handled"),
    });
    assert.deepEqual(calls, ["handled", "note-only"], name);
    assert.equal(store.useMeetingRecordingStore.getState().error, null, name);
  }
});
