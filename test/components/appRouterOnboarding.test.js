const assert = require("node:assert/strict");
const test = require("node:test");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHostDom,
} = require("../lib/rendererTestHarness");

async function createRouterHarness(t, initialStorage = {}) {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  const { storage } = installBrowserGlobals(t, {
    initialStorage,
    window: { location: { search: "?control-panel=true" } },
  });
  const container = installHostDom(t);
  const state = {
    auth: { isLoaded: true, isSignedIn: false, isGracePeriodOnly: false },
    policy: {
      deviceReady: true,
      status: "managed",
      localOnly: false,
      requireSignIn: true,
      workspaceRequired: false,
      accountId: null,
    },
  };
  globalThis.__appRouterOnboardingTest = state;
  t.after(() => delete globalThis.__appRouterOnboardingTest);
  const vite = await createRendererServer(t, {
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `export const useTranslation = () => ({ t: (key) => key });`,
      "/App.jsx": `export default function App() { return null; }`,
      "/components/MeetingNotificationOverlay.tsx": `export default function MeetingNotificationOverlay() { return null; }`,
      "/components/onboarding/PermissionGuideOverlay": `export function PermissionGuideOverlay() { return null; }`,
      "/components/ReauthenticationScreen.tsx": `
        export default function ReauthenticationScreen({ requiredByDevice, onContinueWithoutAccount }) {
          return requiredByDevice && !onContinueWithoutAccount ? "required-sign-in" : "optional-sign-in";
        }
      `,
      "/components/onboarding/BackgroundModelDownloadTray.tsx": `export default function BackgroundModelDownloadTray() { return null; }`,
      "/hooks/useAuth": `export const useAuth = () => globalThis.__appRouterOnboardingTest.auth;`,
      "/hooks/useControlPanelWindowDrag": `export function useControlPanelWindowDrag() {}`,
      "/hooks/useTheme": `export function useTheme() {}`,
      "/lib/accountScopeMirror": `export function mirrorActiveAccountScope() {}`,
      "/stores/policyStore": `
        export const usePolicyStore = (selector) => selector(globalThis.__appRouterOnboardingTest.policy);
        usePolicyStore.getState = () => ({ bootstrap: async () => {} });
      `,
      "/lib/auth": `export async function signOut() {}`,
      "/components/ui/button": `export function Button({ children }) { return children; }`,
      "/utils/windowContext.ts": `export const isControlPanelWindow = () => true; export const isAgentWindow = () => false;`,
      "/components/ControlPanel.tsx": `export default function ControlPanel() { return "control-panel"; }`,
      "/components/agent/AgentWindow.tsx": `export default function AgentWindow() { return null; }`,
      "/services/SyncService.js": `export const syncService = { startAutoSync() {} };`,
      // Keep the flow's real persistence hook: OAuth reloads depend on its markers.
      "/components/OnboardingFlow.tsx": `
        import { useOnboardingSession } from "/components/onboarding/useOnboardingSession.ts";
        export default function OnboardingFlow() {
          const { session } = useOnboardingSession();
          return "onboarding:" + session.currentStepId;
        }
      `,
    },
  });
  const { default: AppRouter } = await vite.ssrLoadModule("/AppRouter.jsx");
  const flow = await vite.ssrLoadModule("/components/onboarding/flow.ts");
  await Promise.all([
    vite.ssrLoadModule("/components/OnboardingFlow.tsx"),
    vite.ssrLoadModule("/components/ControlPanel.tsx"),
  ]);
  root = createRoot(container);
  const render = async () => {
    await React.act(async () => {
      root.render(React.createElement(AppRouter));
    });
  };
  const reloadAfterSignIn = async () => {
    // main.js reloads the control panel when it receives an OAuth bearer token.
    await React.act(async () => root.unmount());
    state.auth.isSignedIn = true;
    state.policy.accountId = "signed-in-account";
    state.policy.status = "loading";
    root = createRoot(container);
    await render();
    state.policy.status = "managed";
    await render();
  };
  return { container, storage, flow, render, reloadAfterSignIn };
}

test("required first sign-in preserves onboarding across the OAuth reload", async (t) => {
  const { container, storage, flow, render, reloadAfterSignIn } = await createRouterHarness(t);
  await render();
  assert.equal(container.textContent, "required-sign-in");
  assert.equal(storage.getItem("onboardingCompleted"), null);

  await reloadAfterSignIn();
  assert.equal(storage.getItem("onboardingCompleted"), null);
  assert.equal(container.textContent, "onboarding:auth");
  assert.equal(
    flow.parseOnboardingSession(storage.getItem(flow.ONBOARDING_SESSION_KEY)).currentStepId,
    "auth"
  );
});

for (const [step, authPath] of [
  ["permissions", "guest"],
  ["required-models", "account"],
]) {
  test(`required sign-in preserves unfinished ${step} setup`, async (t) => {
    const { container, storage, flow, render, reloadAfterSignIn } = await createRouterHarness(t);
    storage.setItem(
      flow.ONBOARDING_SESSION_KEY,
      JSON.stringify({ ...flow.createOnboardingSession(), currentStepId: step, authPath })
    );
    await render();
    assert.equal(container.textContent, "required-sign-in");

    await reloadAfterSignIn();
    assert.equal(storage.getItem("onboardingCompleted"), null);
    assert.equal(container.textContent, `onboarding:${step}`);
    assert.equal(
      flow.parseOnboardingSession(storage.getItem(flow.ONBOARDING_SESSION_KEY)).authPath,
      authPath
    );
  });
}

test("required reauthentication does not restart completed guest onboarding", async (t) => {
  const { container, storage, flow, render, reloadAfterSignIn } = await createRouterHarness(t, {
    onboardingCompleted: "true",
    authenticationSkipped: "true",
    skipAuth: "true",
  });
  await render();
  assert.equal(container.textContent, "required-sign-in");
  assert.equal(storage.getItem(flow.ONBOARDING_SESSION_KEY), null);

  await reloadAfterSignIn();
  assert.equal(container.textContent, "control-panel");
  assert.equal(storage.getItem("onboardingCompleted"), "true");
  assert.equal(storage.getItem(flow.ONBOARDING_SESSION_KEY), null);
});
