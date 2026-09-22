const assert = require("node:assert/strict");
const test = require("node:test");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

function find(node, predicate) {
  if (Array.isArray(node)) return node.map((child) => find(child, predicate)).find(Boolean);
  if (!node || typeof node !== "object") return null;
  return predicate(node) ? node : find(node.props?.children, predicate);
}
const named = (tree, name) => find(tree, (node) => node.type?.name === name);
const labelled = (tree, label) => find(tree, (node) => node.props?.children === label);
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

// Mount the real flow, recovery dialog, compact auth and auth/verification
// screens with React's hooks. Inspect their element output without a layout
// engine; only desktop, account, policy and network boundaries are replaced.
async function mountFlow(
  t,
  {
    kind = "dictation",
    ordinary = false,
    initialPending = null,
    signedIn = false,
    staleSuccess = false,
  } = {}
) {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    delete globalThis.__verificationRecovery;
  });
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const state = {
    auth: {
      isLoaded: true,
      isSignedIn: signedIn,
      user: signedIn ? { id: "new-user", email: "new@example.test", emailVerified: false } : null,
    },
    signup: deferred(),
    refresh: deferred(),
    signout: deferred(),
    refreshCalls: 0,
    signoutCalls: 0,
    mailCount: 0,
    proof: false,
    status: 200,
    starts: [],
    continuation: [],
  };
  globalThis.__verificationRecovery = state;
  const { storage } = installBrowserGlobals(t, {
    window: {
      setTimeout: (...args) => setTimeout(...args),
      clearTimeout: (id) => clearTimeout(id),
      electronAPI: {
        getPlatform: () => "linux",
        beginOnboardingDemo: async (session) => {
          state.starts.push(session);
          return true;
        },
        endOnboardingDemo: async () => true,
        onOnboardingDemoEvent: (listener) => {
          state.listener = listener;
          return () => {
            state.listener = null;
          };
        },
      },
    },
  });
  const container = installHookDom(t);
  globalThis.document.body = container;
  t.mock.method(globalThis, "fetch", async () => ({
    ok: state.status === 200,
    status: state.status,
    json: async () => ({ verified: state.proof }),
  }));
  const mocks = {
    "react-i18next": `const t = key => key; export function useTranslation() { return { t }; } export const initReactI18next = { type: "3rdParty", init() {} };`,
    "canvas-confetti": `export default { create() { return Object.assign(() => {}, { reset() {} }); } };`,
    "onboarding-founder.webp": `export default "founder.webp";`,
    "icons/gmail.svg": `export default "gmail.svg";`,
    "/config/constants": `export * from "/config/constants.ts"; export const OPENWHISPR_API_URL = "https://api.openwhispr.test";`,
    "/hooks/useAuth": `export function useAuth() { return { ...globalThis.__verificationRecovery.auth, refetch }; }
      async function refetch() { const s = globalThis.__verificationRecovery; s.refreshCalls++; await s.refresh.promise; }`,
    "/lib/auth": `export const AUTH_URL = "https://auth.openwhispr.test";
      export const authClient = {
        signUp: { email: async () => globalThis.__verificationRecovery.signup.promise },
        signIn: { email: async () => ({}) },
        sendVerificationEmail: async () => { globalThis.__verificationRecovery.mailCount++; return {}; },
      };
      export async function signOut() { const s = globalThis.__verificationRecovery; s.signoutCalls++; await s.signout.promise; s.auth = { isLoaded: true, isSignedIn: false, user: null }; }
      export async function signInWithSocial() { return {}; }
      export async function signInWithSSO() { return {}; }
      export function updateLastSignInTime() {}`,
    "/utils/logger": `export default { debug() {}, info() {}, warn() {}, error() {} };`,
    "/utils/platform": `export function getPlatform() { return "linux"; } export function getCachedPlatform() { return "linux"; }`,
    "/hooks/useSettings": `export function useSettings() { return globalThis.__verificationRecovery.settings; }`,
    "/hooks/useClipboard": `export function useClipboard() {}`,
    "/hooks/usePermissions": `export function usePermissions() { return { micPermissionGranted: true }; }`,
    "/hooks/useScreenRecordingPermission": `export function useScreenRecordingPermission() { return { isMacOS: false, granted: false, needsRelaunch: false }; }`,
    "/hooks/useSystemAudioPermission": `export function useSystemAudioPermission() { return {}; }`,
    "/hooks/useLocalStorage": `export function useLocalStorage(key, value) { return [value, () => {}]; }`,
    "/hooks/useHotkeyRegistration": `export function useHotkeyRegistration() { return { registerHotkey: async () => true, isRegistering: false }; }`,
    "/hooks/useHotkeyModeInfo": `export function useHotkeyModeInfo() { return { supportsPushToTalk: true, loaded: true }; }`,
    "/hooks/useWorkspace": `const workspaces = []; export function useWorkspace() { return { active: null, workspaces, loaded: true }; }`,
    "/hooks/useRequiredLocalModels": `const missing = []; export function useRequiredLocalModels() { return { missing, loading: false }; }`,
    "/stores/policyStore": `const state = { status: "unmanaged", policy: null }; export function usePolicyStore(select) { return select ? select(state) : state; }`,
    "/services/cloudApi": `export async function cloudPost() {}`,
    "/onboarding/OnboardingShell": `export default function OnboardingShell() { return null; } export function OnboardingStepHeader() { return null; } export function CompactOnboardingFrame() { return null; }`,
    "/ui/dialog": `export function Dialog() { return null; } export function DialogContent() { return null; } export function DialogTitle() { return null; } export function DialogDescription() { return null; } export function AlertDialog() { return null; }`,
    "/onboarding/ProviderSetupStep": `export function ByokProviderStep() { return null; } export function LocalModelSetupStep() { return null; }`,
    "/onboarding/RequiredModelDownloadStep": `export function RequiredModelDownloadStep() { return null; }`,
  };
  for (const name of [
    "UseCaseStep",
    "CompactPermissionsStep",
    "LanguageSelectionStep",
    "ShortcutSetupStep",
    "OnboardingHotkeyGestureCard",
    "AssistantHotkeyPreview",
    "CalendarConnectionsStep",
    "SetupChoiceStep",
  ]) {
    mocks[`/onboarding/${name}`] = `export default function ${name}() { return null; }`;
  }
  const vite = await createRendererServer(t, {
    cachePrefix: "onboarding-verification-recovery-",
    noExternal: ["react-i18next"],
    mockModules: mocks,
  });
  const { createOnboardingSession, ONBOARDING_SESSION_KEY } = await vite.ssrLoadModule(
    "/components/onboarding/flow.ts"
  );
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  useSettingsStore.setState({ useLocalWhisper: false, cloudTranscriptionMode: "openwhispr" });
  state.settings = useSettingsStore.getState();
  const initial = createOnboardingSession();
  initial.currentStepId = ordinary ? "auth" : `${kind}-demo`;
  initial.authPath = ordinary ? null : "account";
  initial.resume.auth = {
    ...initial.resume.auth,
    authMode: "sign-up",
    email: "new@example.test",
    fullName: "New Person",
    pendingVerificationEmail: initialPending,
  };
  initial.resume[`${kind}DemoCompleted`] = staleSuccess;
  storage.setItem(ONBOARDING_SESSION_KEY, JSON.stringify(initial));
  const { default: OnboardingFlow } = await vite.ssrLoadModule("/components/OnboardingFlow.tsx");
  function Leaf({ element }) {
    state.leafElement = element;
    state.leaf = element.type(element.props);
    return null;
  }
  function Compact({ element }) {
    const leaf = element.type(element.props);
    return React.createElement(Leaf, { element: leaf, key: `${leaf.type.name}:${leaf.key ?? ""}` });
  }
  function Dialog({ element }) {
    state.dialog = element;
    const tree = element.type(element.props);
    const compact = named(tree, "CompactAuthenticationFlow");
    // Before the fix the dialog directly renders the leaf auth screens.
    if (!compact) {
      const leaf = named(tree, "AuthenticationStep") || named(tree, "EmailVerificationStep");
      return element.props.open && leaf
        ? React.createElement(Leaf, { element: leaf, key: `${leaf.type.name}:${leaf.key ?? ""}` })
        : null;
    }
    return React.createElement(Compact, { element: compact });
  }
  function Demo({ element }) {
    state.demoElement = element;
    state.demo = element.type(element.props);
    return React.createElement(Dialog, { element: named(state.demo, "SignInDialog") });
  }
  function Harness() {
    state.flow = OnboardingFlow({ onComplete() {} });
    const shell = named(state.flow, "OnboardingShell");
    state.continuation.push(shell.props.continueDisabled);
    const demo = named(state.flow, "DemoStep");
    if (demo) return React.createElement(Demo, { element: demo });
    const compact = named(state.flow, "CompactAuthenticationFlow");
    return compact ? React.createElement(Compact, { element: compact }) : null;
  }
  root = createRoot(container);
  const render = () => React.act(async () => root.render(React.createElement(Harness)));
  await render();
  const advance = (ms) => React.act(async () => t.mock.timers.tick(ms));
  await advance(1600);
  return {
    state,
    stored: () => JSON.parse(storage.getItem(ONBOARDING_SESSION_KEY)),
    render,
    advance,
    surface: () => named(state.demo, "VoiceSurface"),
    shell: () => named(state.flow, "OnboardingShell"),
    remount: async () => {
      await React.act(async () => root.unmount());
      root = createRoot(container);
      await render();
      await advance(1600);
    },
    submitSignup: async () => {
      await React.act(async () =>
        find(state.leaf, (node) => node.props?.type === "password").props.onChange({
          target: { value: "not-a-real-password" },
        })
      );
      let pending;
      await React.act(async () => {
        pending = find(state.leaf, (node) => node.type === "form").props.onSubmit({
          preventDefault() {},
        });
      });
      return {
        settle: async () =>
          React.act(async () => {
            state.signup.resolve({});
            await pending;
          }),
      };
    },
  };
}

for (const kind of ["dictation", "assistant"]) {
  test(`${kind} signup recovery survives policy replacement and waits for refreshed verification`, async (t) => {
    const flow = await mountFlow(t, { kind });
    const { state } = flow;
    await React.act(async () => flow.surface().props.onChange("Keep this practice text"));
    await React.act(async () => flow.surface().props.onRetry());
    assert.equal(state.dialog.props.open, true);
    const signup = await flow.submitSignup();
    await signup.settle();
    assert.equal(flow.stored().resume.auth.pendingVerificationEmail, "new@example.test");
    state.auth = {
      isLoaded: true,
      isSignedIn: true,
      user: { id: "new-user", email: "new@example.test", emailVerified: false },
    };
    await flow.remount();
    assert.equal(state.dialog.props.open, true);
    assert.equal(state.leafElement.type.name, "EmailVerificationStep");
    assert.equal(state.leafElement.props.resumed, true);
    assert.equal(state.leafElement.props.embedded, true);
    assert.equal(state.mailCount, 0, "restoring verification sends no email");
    assert.equal(state.starts.length, 0);
    assert.equal(flow.shell().props.continueDisabled, true);
    assert.equal(flow.surface().props.value, "Keep this practice text");
    await React.act(async () => state.dialog.props.onOpenChange(false));
    assert.equal(flow.stored().resume.auth.pendingVerificationEmail, "new@example.test");
    assert.equal(state.starts.length, 0);
    await React.act(async () => flow.surface().props.onRetry());
    assert.equal(state.leafElement.type.name, "EmailVerificationStep");
    state.proof = true;
    await flow.advance(5000);
    assert.equal(state.refreshCalls, 1);
    await flow.advance(2000);
    assert.equal(state.starts.length, 0, "endpoint proof cannot bypass session refresh");
    assert.equal(flow.stored().resume.auth.pendingVerificationEmail, "new@example.test");
    await React.act(async () => {
      state.auth.user = { ...state.auth.user, emailVerified: true };
      state.refresh.resolve();
    });
    await flow.render();
    await flow.advance(1200);
    assert.equal(flow.stored().resume.auth.pendingVerificationEmail, null);
    assert.equal(state.starts.length, 1);
    assert.equal(flow.surface().props.value, "Keep this practice text");
    assert.equal(flow.shell().props.continueDisabled, true, "verification is not practice success");
    await React.act(async () =>
      state.listener({
        demoId: state.starts[0].id,
        kind,
        status: "success",
        text: "Practice succeeded",
      })
    );
    assert.equal(flow.shell().props.continueDisabled, false);
  });

  test(`${kind} fences an unverified session published before signup finishes`, async (t) => {
    const flow = await mountFlow(t, { kind });
    const { state } = flow;
    await React.act(async () => flow.surface().props.onRetry());
    const signup = await flow.submitSignup();
    state.auth = {
      isLoaded: true,
      isSignedIn: true,
      user: { id: "new-user", email: "new@example.test", emailVerified: false },
    };
    await flow.remount();
    assert.equal(state.starts.length, 0);
    assert.equal(state.dialog.props.open, true);
    assert.equal(state.leafElement.type.name, "EmailVerificationStep");
    assert.equal(state.leafElement.props.email, "new@example.test");
    state.proof = true;
    await flow.advance(5000);
    await React.act(async () => {
      state.auth.user = { ...state.auth.user, emailVerified: true };
      state.refresh.resolve();
    });
    await flow.render();
    await flow.advance(1200);
    assert.equal(state.starts.length, 1);
    await signup.settle();
    assert.equal(
      flow.stored().resume.auth.pendingVerificationEmail,
      null,
      "an old signup callback cannot restore the completed verification draft"
    );
    assert.equal(state.starts.length, 1);
  });

  test(`${kind} Continue is disabled on the first render over a stale practice success`, async (t) => {
    const flow = await mountFlow(t, {
      kind,
      signedIn: true,
      initialPending: "new@example.test",
      staleSuccess: true,
    });
    assert.equal(
      flow.state.continuation[0],
      true,
      "the parent fences Continue before child effects clear saved success"
    );
    assert.equal(flow.state.starts.length, 0);
  });

  test(`${kind} checkpoints an early signup address before Back crosses another remount`, async (t) => {
    const flow = await mountFlow(t, { kind });
    const { state } = flow;
    await React.act(async () => flow.surface().props.onRetry());
    const signup = await flow.submitSignup();
    state.auth = {
      isLoaded: true,
      isSignedIn: true,
      user: { id: "new-user", email: "new@example.test", emailVerified: false },
    };
    await flow.remount();
    assert.equal(flow.stored().resume.auth.pendingVerificationEmail, "new@example.test");
    await React.act(async () =>
      labelled(state.leaf, "emailVerification.backToSignIn").props.onClick()
    );
    state.auth = { isLoaded: true, isSignedIn: false, user: null };
    await flow.remount();
    await React.act(async () => state.signout.resolve());
    await flow.render();
    assert.equal(state.dialog.props.open, true);
    assert.equal(state.leafElement.type.name, "AuthenticationStep");
    assert.equal(flow.stored().resume.auth.pendingVerificationEmail, null);
    assert.equal(flow.stored().resume.auth.authMode, "sign-in");
    await signup.settle();
    assert.equal(flow.stored().resume.auth.pendingVerificationEmail, null);
    assert.equal(state.starts.length, 0);
  });
}

test("ordinary email signup refreshes its verified account before continuing to permissions", async (t) => {
  const flow = await mountFlow(t, { ordinary: true });
  const { state } = flow;
  const signup = await flow.submitSignup();
  await signup.settle();
  assert.equal(flow.stored().resume.auth.pendingVerificationEmail, "new@example.test");
  assert.equal(state.leafElement.type.name, "EmailVerificationStep");
  assert.notEqual(state.leafElement.props.embedded, true);
  state.auth = {
    isLoaded: true,
    isSignedIn: true,
    user: { id: "new-user", email: "new@example.test", emailVerified: false },
  };
  state.proof = true;
  await flow.advance(5000);
  await flow.advance(1200);
  assert.equal(flow.stored().currentStepId, "auth");
  await React.act(async () => {
    state.auth.user = { ...state.auth.user, emailVerified: true };
    state.refresh.resolve();
  });
  await flow.render();
  await flow.advance(1200);
  assert.equal(flow.stored().currentStepId, "permissions");
  assert.equal(flow.stored().resume.auth.pendingVerificationEmail, null);
});

for (const ordinary of [true, false]) {
  test(`${ordinary ? "ordinary signup" : "practice recovery"} keeps retry and Back usable after refresh failure`, async (t) => {
    const flow = await mountFlow(t, {
      ordinary,
      signedIn: true,
      initialPending: "new@example.test",
    });
    const { state } = flow;
    state.proof = true;
    await flow.advance(5000);
    state.refresh.resolve(); // The SDK resolves void even when its network request failed.
    await flow.render();
    await flow.advance(1200);
    assert.equal(state.leafElement.type.name, "EmailVerificationStep");
    assert.ok(labelled(state.leaf, "emailVerification.backToSignIn"));
    assert.ok(labelled(state.leaf, "emailVerification.errors.serverUnreachable"));
    assert.equal(state.starts.length, 0);
    state.refresh = deferred();
    await flow.advance(5000);
    assert.equal(state.refreshCalls, 2, "a failed refresh remains retryable");
    await React.act(async () => {
      state.auth.user = { ...state.auth.user, emailVerified: true };
      state.refresh.resolve();
    });
    await flow.render();
    await flow.advance(1200);
    assert.equal(flow.stored().resume.auth.pendingVerificationEmail, null);
    assert.equal(flow.stored().currentStepId, ordinary ? "permissions" : "dictation-demo");
    assert.equal(state.starts.length, ordinary ? 0 : 1);
  });
}

test("verification Back waits for sign-out, clears pending state, and permits another account", async (t) => {
  const flow = await mountFlow(t, { signedIn: true, initialPending: "old@example.test" });
  const { state } = flow;
  await React.act(async () =>
    labelled(state.leaf, "emailVerification.backToSignIn").props.onClick()
  );
  assert.equal(state.signoutCalls, 1);
  assert.equal(flow.stored().resume.auth.pendingVerificationEmail, "old@example.test");
  await React.act(async () => state.signout.resolve());
  await flow.render();
  assert.equal(flow.stored().resume.auth.pendingVerificationEmail, null);
  assert.equal(flow.stored().resume.auth.authMode, "sign-in");
  assert.equal(state.leafElement.type.name, "AuthenticationStep");
  state.auth = {
    isLoaded: true,
    isSignedIn: true,
    user: { id: "other-user", email: "other@example.test", emailVerified: true },
  };
  await flow.render();
  assert.equal(state.starts.length, 1);
  assert.equal(flow.stored().resume.auth.pendingVerificationEmail, null);
});

test("expired and rejected verification refreshes retain Back without completing", async (t) => {
  const flow = await mountFlow(t, { signedIn: true, initialPending: "new@example.test" });
  const { state } = flow;
  state.proof = true;
  await flow.advance(5000);
  await React.act(async () => state.refresh.reject(new Error("Network offline")));
  assert.ok(labelled(state.leaf, "emailVerification.backToSignIn"));
  assert.ok(labelled(state.leaf, "emailVerification.errors.serverUnreachable"));
  state.refresh = deferred();
  await flow.advance(5000);
  await React.act(async () => {
    state.auth = { isLoaded: true, isSignedIn: false, user: null };
    state.refresh.resolve();
  });
  await flow.render();
  assert.ok(labelled(state.leaf, "auth.sessionExpired"));
  state.status = 401;
  await flow.advance(5000);
  assert.ok(labelled(state.leaf, "auth.sessionExpired"));
  assert.equal(state.starts.length, 0);
  assert.equal(flow.stored().resume.auth.pendingVerificationEmail, "new@example.test");
});

test("Back still completes when sign-out replaces the policy tree before resolving", async (t) => {
  const flow = await mountFlow(t, { signedIn: true, initialPending: "new@example.test" });
  const { state } = flow;
  await React.act(async () =>
    labelled(state.leaf, "emailVerification.backToSignIn").props.onClick()
  );
  state.auth = { isLoaded: true, isSignedIn: false, user: null };
  await flow.remount();
  assert.equal(flow.stored().resume.auth.pendingVerificationEmail, "new@example.test");
  await React.act(async () => state.signout.resolve());
  await flow.render();
  assert.equal(flow.stored().resume.auth.pendingVerificationEmail, null);
  assert.equal(state.dialog.props.open, true);
  assert.equal(state.leafElement.type.name, "AuthenticationStep");
  assert.equal(state.starts.length, 0);
});

test("changing accounts during the verified notice cancels auth completion", async (t) => {
  const flow = await mountFlow(t, {
    ordinary: true,
    signedIn: true,
    initialPending: "new@example.test",
  });
  const { state } = flow;
  state.proof = true;
  await flow.advance(5000);
  await React.act(async () => {
    state.auth.user = { ...state.auth.user, emailVerified: true };
    state.refresh.resolve();
  });
  await flow.render();
  await flow.advance(500);
  state.auth = {
    isLoaded: true,
    isSignedIn: true,
    user: { id: "different", email: "different@example.test", emailVerified: true },
  };
  await flow.render();
  await flow.advance(1200);
  assert.equal(flow.stored().currentStepId, "auth");
  assert.equal(flow.stored().resume.auth.pendingVerificationEmail, "new@example.test");
  assert.ok(labelled(state.leaf, "emailVerification.backToSignIn"));
});

test("closing verification during Back consumes its settled sign-out when reopened", async (t) => {
  const flow = await mountFlow(t, { signedIn: true, initialPending: "new@example.test" });
  const { state } = flow;
  await React.act(async () =>
    labelled(state.leaf, "emailVerification.backToSignIn").props.onClick()
  );
  await React.act(async () => state.dialog.props.onOpenChange(false));
  await React.act(async () => state.signout.resolve());
  await flow.render();
  assert.equal(flow.stored().resume.auth.pendingVerificationEmail, "new@example.test");
  await React.act(async () => flow.surface().props.onRetry());
  assert.equal(flow.stored().resume.auth.pendingVerificationEmail, null);
  assert.equal(state.dialog.props.open, true);
  assert.equal(state.leafElement.type.name, "AuthenticationStep");
  assert.equal(state.signoutCalls, 1);
});

test("a retained Back result cannot clear a different pending address", async (t) => {
  const flow = await mountFlow(t, { signedIn: true, initialPending: "new@example.test" });
  const { state } = flow;
  await React.act(async () =>
    labelled(state.leaf, "emailVerification.backToSignIn").props.onClick()
  );
  await React.act(async () => state.dialog.props.onOpenChange(false));
  await React.act(async () =>
    state.demoElement.props.onAuthResumeStateChange({
      pendingVerificationEmail: "other@example.test",
    })
  );
  await React.act(async () => state.signout.resolve());
  await flow.render();
  await React.act(async () => flow.surface().props.onRetry());
  assert.equal(flow.stored().resume.auth.pendingVerificationEmail, "other@example.test");
  assert.equal(state.leafElement.type.name, "EmailVerificationStep");
  assert.equal(state.leafElement.props.email, "other@example.test");
});

test("a failed verification sign-out retains Back for another attempt", async (t) => {
  const flow = await mountFlow(t, { signedIn: true, initialPending: "new@example.test" });
  const { state } = flow;
  await React.act(async () =>
    labelled(state.leaf, "emailVerification.backToSignIn").props.onClick()
  );
  await React.act(async () => state.signout.reject(new Error("Sign-out unavailable")));
  assert.equal(flow.stored().resume.auth.pendingVerificationEmail, "new@example.test");
  assert.ok(labelled(state.leaf, "emailVerification.backToSignIn"));
  state.signout = deferred();
  await React.act(async () =>
    labelled(state.leaf, "emailVerification.backToSignIn").props.onClick()
  );
  assert.equal(state.signoutCalls, 2);
  await React.act(async () => state.signout.resolve());
  await flow.render();
  assert.equal(flow.stored().resume.auth.pendingVerificationEmail, null);
  assert.equal(state.leafElement.type.name, "AuthenticationStep");
});

test("verification completing during Back cannot win over the requested sign-out", async (t) => {
  const flow = await mountFlow(t, {
    ordinary: true,
    signedIn: true,
    initialPending: "new@example.test",
  });
  const { state } = flow;
  await React.act(async () =>
    labelled(state.leaf, "emailVerification.backToSignIn").props.onClick()
  );
  state.proof = true;
  await flow.advance(5000);
  await React.act(async () => {
    state.auth.user = { ...state.auth.user, emailVerified: true };
    state.refresh.resolve();
  });
  await flow.render();
  await flow.advance(1200);
  assert.equal(flow.stored().currentStepId, "auth");
  assert.equal(flow.stored().resume.auth.pendingVerificationEmail, "new@example.test");
  await React.act(async () => state.signout.resolve());
  await flow.render();
  assert.equal(state.leafElement.type.name, "AuthenticationStep");
  assert.equal(flow.stored().resume.auth.pendingVerificationEmail, null);
  assert.equal(flow.stored().currentStepId, "auth");
});
