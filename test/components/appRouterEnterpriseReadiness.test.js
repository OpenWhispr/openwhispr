const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { installInteractiveDom } = require("../lib/interactiveDom");

function appRouterMocks() {
  const emptyComponent = `
    import React from "react";
    export default function Empty() { return null; }
  `;
  return {
    "/App.jsx": emptyComponent,
    "/AuthenticationStep.tsx": emptyComponent,
    "/MeetingNotificationOverlay.tsx": emptyComponent,
    "/UpdateNotificationOverlay.tsx": emptyComponent,
    "/WindowControls.tsx": emptyComponent,
    "/onboarding/BackgroundModelDownloadTray.tsx": emptyComponent,
    "/onboarding/ManagedEnterpriseModelCoordinator.tsx": emptyComponent,
    "/ControlPanel.tsx": emptyComponent,
    "/OnboardingFlow.tsx": emptyComponent,
    "/ui/card.tsx": `
      import React from "react";
      export function Card({ children }) { return React.createElement("div", null, children); }
      export function CardContent({ children }) { return React.createElement("div", null, children); }
    `,
    "/onboarding/flow": `
      export const LEGACY_ONBOARDING_STEP_KEY = "onboardingStep";
      export const ONBOARDING_SESSION_KEY = "onboardingSession";
    `,
    "/hooks/useAuth": `
      export function useAuth() { return globalThis.__appRouterAuth; }
    `,
    "/hooks/useTheme": `export function useTheme() {}`,
    "/stores/policyStore": `
      export function usePolicyStore(selector) { return selector(globalThis.__appRouterPolicy); }
    `,
    "/stores/enterpriseIdentityStore": `
      export function useEnterpriseIdentityStore(selector) {
        return selector(globalThis.__appRouterEnterprise);
      }
    `,
    "/utils/windowContext": `export function isControlPanelWindow() { return false; }`,
    "react-i18next": `
      export function useTranslation() { return { t(key) { return key; } }; }
    `,
  };
}

test("AppRouter only releases inference after auth, policy, and enterprise identity resolve", async (t) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-app-router-enterprise-readiness-",
  });
  const { isEnterpriseInferenceReady } = await vite.ssrLoadModule(
    "/helpers/enterpriseInferenceReadiness.ts"
  );

  assert.equal(
    isEnterpriseInferenceReady({
      authLoaded: true,
      policyResolved: true,
      isSignedIn: true,
      enterpriseStatus: "idle",
      enterpriseFailClosed: false,
    }),
    false
  );
  assert.equal(
    isEnterpriseInferenceReady({
      authLoaded: true,
      policyResolved: true,
      isSignedIn: true,
      enterpriseStatus: "loading",
      enterpriseFailClosed: false,
    }),
    false
  );
  assert.equal(
    isEnterpriseInferenceReady({
      authLoaded: true,
      policyResolved: true,
      isSignedIn: false,
      enterpriseStatus: "idle",
      enterpriseFailClosed: false,
    }),
    true
  );
  assert.equal(
    isEnterpriseInferenceReady({
      authLoaded: true,
      policyResolved: true,
      isSignedIn: true,
      enterpriseStatus: "ready",
      enterpriseFailClosed: false,
    }),
    true
  );
  assert.equal(
    isEnterpriseInferenceReady({
      authLoaded: true,
      policyResolved: true,
      isSignedIn: true,
      enterpriseStatus: "error",
      enterpriseFailClosed: false,
    }),
    true
  );
  assert.equal(
    isEnterpriseInferenceReady({
      authLoaded: true,
      policyResolved: true,
      isSignedIn: true,
      enterpriseStatus: "error",
      enterpriseFailClosed: true,
    }),
    false
  );
  assert.equal(
    isEnterpriseInferenceReady({
      authLoaded: false,
      policyResolved: true,
      isSignedIn: false,
      enterpriseStatus: "idle",
      enterpriseFailClosed: false,
    }),
    false
  );
});

test("AppRouter re-closes the main-process onboarding gate when enterprise readiness regresses", async (t) => {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    delete globalThis.__appRouterAuth;
    delete globalThis.__appRouterPolicy;
    delete globalThis.__appRouterEnterprise;
  });

  const onboardingActiveCalls = [];
  installBrowserGlobals(t, {
    initialStorage: { onboardingCompleted: "true" },
    window: {
      location: { search: "" },
      electronAPI: {
        setOnboardingActive: async (active) => onboardingActiveCalls.push(active),
      },
    },
  });
  const container = installInteractiveDom(t);
  globalThis.__appRouterAuth = {
    isSignedIn: true,
    isGracePeriodOnly: false,
    isLoaded: true,
  };
  globalThis.__appRouterPolicy = { status: "unmanaged" };
  globalThis.__appRouterEnterprise = { status: "ready", failClosed: false };

  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-app-router-enterprise-transition-",
    noExternal: ["react-i18next"],
    mockModules: appRouterMocks(),
  });
  const { default: AppRouter } = await vite.ssrLoadModule("/AppRouter.jsx");
  root = createRoot(container);

  await React.act(async () => {
    root.render(React.createElement(AppRouter));
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.equal(onboardingActiveCalls.at(-1), false);

  globalThis.__appRouterEnterprise = { status: "loading", failClosed: true };
  await React.act(async () => {
    root.render(React.createElement(AppRouter));
    await new Promise((resolve) => setImmediate(resolve));
  });

  assert.deepEqual(onboardingActiveCalls.slice(-2), [false, true]);
});
