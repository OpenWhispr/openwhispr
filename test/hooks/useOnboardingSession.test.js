const assert = require("node:assert/strict");
const test = require("node:test");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

test("session checkpoints merge before React commits and finalization cannot recreate progress", async (t) => {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  const { storage } = installBrowserGlobals(t);
  const container = installHookDom(t);
  const vite = await createRendererServer(t, { cachePrefix: "onboarding-session-checkpoints-" });
  const { useOnboardingSession } = await vite.ssrLoadModule(
    "/components/onboarding/useOnboardingSession.ts"
  );
  const { ONBOARDING_SESSION_KEY, LEGACY_ONBOARDING_STEP_KEY } = await vite.ssrLoadModule(
    "/components/onboarding/flow.ts"
  );
  let state;
  function Harness() {
    state = useOnboardingSession();
    return null;
  }
  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(Harness)));
  const setter = state.setSession;
  await React.act(async () => {
    state.setAuthPath("account");
    state.goTo("dictation-demo");
    state.setSession((current) => ({
      ...current,
      resume: {
        ...current.resume,
        demoRecoveryDrafts: { dictation: { text: "Draft", transcript: "Speech" } },
      },
    }));
    state.setSession((current) => ({
      ...current,
      resume: {
        ...current.resume,
        auth: { ...current.resume.auth, pendingVerificationEmail: "new@example.test" },
      },
    }));
    state.setSession((current) => ({
      ...current,
      resume: { ...current.resume, dictationHotkeyConfirmed: true },
    }));
    const saved = JSON.parse(storage.getItem(ONBOARDING_SESSION_KEY));
    assert.equal(saved.currentStepId, "dictation-demo");
    assert.equal(saved.authPath, "account");
    assert.equal(saved.resume.auth.pendingVerificationEmail, "new@example.test");
    assert.deepEqual(saved.resume.demoRecoveryDrafts.dictation, {
      text: "Draft",
      transcript: "Speech",
    });
    assert.equal(saved.resume.dictationHotkeyConfirmed, true);
    assert.equal(storage.getItem(LEGACY_ONBOARDING_STEP_KEY), "dictation-demo");
    root.unmount();
  });
  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(Harness)));
  assert.equal(state.session.currentStepId, "dictation-demo");
  assert.equal(state.session.resume.auth.pendingVerificationEmail, "new@example.test");
  const remountedSetter = state.setSession;
  await React.act(async () => state.goBack());
  assert.equal(state.session.currentStepId, "auth");
  assert.equal(
    state.setSession,
    remountedSetter,
    "draft callbacks must stay stable across renders"
  );
  assert.notEqual(setter, remountedSetter);
  await React.act(async () => {
    state.clearSession();
    // A queued leaf cleanup may flush its last draft during finalization.
    state.setSession((current) => ({ ...current, authPath: "account" }));
  });
  assert.equal(storage.getItem(ONBOARDING_SESSION_KEY), null);
  assert.equal(storage.getItem(LEGACY_ONBOARDING_STEP_KEY), null);
});
