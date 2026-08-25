const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

function findButtons(node, controls = []) {
  if (Array.isArray(node)) {
    node.forEach((child) => findButtons(child, controls));
    return controls;
  }
  if (!node || typeof node !== "object") return controls;
  if (node.type === "button") controls.push(node);
  findButtons(node.props?.children, controls);
  return controls;
}

function findText(node, values = []) {
  if (Array.isArray(node)) {
    node.forEach((child) => findText(child, values));
    return values;
  }
  if (typeof node === "string") values.push(node);
  else if (node && typeof node === "object") findText(node.props?.children, values);
  return values;
}

test("normal app surfaces wait for the signed-in enterprise identity to settle", async (t) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-app-router-enterprise-readiness-",
  });
  const { shouldWaitForEnterpriseReadiness } = await vite.ssrLoadModule(
    "/stores/enterpriseIdentityStore.ts"
  );

  assert.equal(shouldWaitForEnterpriseReadiness(false, "idle"), false);
  assert.equal(shouldWaitForEnterpriseReadiness(true, "loading"), true);
  assert.equal(shouldWaitForEnterpriseReadiness(true, "idle"), true);
  assert.equal(shouldWaitForEnterpriseReadiness(true, "ready", "configured"), false);
  assert.equal(shouldWaitForEnterpriseReadiness(true, "error", "unmanaged"), false);
  assert.equal(shouldWaitForEnterpriseReadiness(true, "error", "unknown"), true);
});

test("suppressed shell exposes recovery and loaded workspace selection", async (t) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-enterprise-recovery-test-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `export const useTranslation = () => ({ t: (key) => key });`,
    },
  });
  const { EnterpriseReadinessRecovery } = await vite.ssrLoadModule(
    "/components/EnterpriseReadinessRecovery.tsx"
  );
  let retries = 0;
  let signOuts = 0;
  const element = EnterpriseReadinessRecovery({
    onRetry: () => {
      retries += 1;
    },
    onSignOut: () => {
      signOuts += 1;
    },
  });
  const controls = findButtons(element);
  assert.equal(controls.length, 2);
  controls[0].props.onClick();
  controls[1].props.onClick();
  assert.equal(retries, 1);
  assert.equal(signOuts, 1);

  let selectedWorkspaceId = null;
  const selectionElement = EnterpriseReadinessRecovery({
    onRetry: () => {},
    onSignOut: () => {},
    onSelectWorkspace: (workspaceId) => {
      selectedWorkspaceId = workspaceId;
    },
    workspaces: [
      { id: "workspace-a", name: "Workspace A" },
      { id: "workspace-b", name: "Workspace B" },
    ],
  });
  assert.deepEqual(findText(selectionElement).slice(0, 3), [
    "workspaces.switcher.workspaces",
    "Workspace A",
    "Workspace B",
  ]);
  const selectionControls = findButtons(selectionElement);
  selectionControls[1].props.onClick();
  assert.equal(selectedWorkspaceId, "workspace-b");
});

test("recovery copy uses localized values", async (t) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-enterprise-recovery-i18n-test-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `
        export const useTranslation = () => ({ t: (key) => \`translated:\${key}\` });
      `,
    },
  });
  const { EnterpriseReadinessRecovery } = await vite.ssrLoadModule(
    "/components/EnterpriseReadinessRecovery.tsx"
  );
  const element = EnterpriseReadinessRecovery({ onRetry: () => {}, onSignOut: () => {} });
  assert.deepEqual(findText(element), [
    "translated:settingsPage.workspace.loadError.title",
    "translated:settingsPage.workspace.loadError.description",
    "translated:settingsPage.workspace.loadError.retry",
    "translated:settingsPage.account.signOut.signOut",
  ]);
});

test("AppRouter keeps later unknown enterprise failures suppressed and wires recovery", async (t) => {
  const calls = [];
  globalThis.__enterpriseRecoveryProps = null;
  globalThis.__workspaceRefreshes = 0;
  globalThis.__signOuts = 0;
  installBrowserGlobals(t, {
    initialStorage: { onboardingCompleted: "true" },
    window: {
      location: { search: "" },
      electronAPI: {
        setOnboardingActive: (active) => calls.push(active),
      },
    },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-app-router-wiring-test-",
    noExternal: ["react", "react-i18next"],
    mockModules: {
      react: `
        let stateCalls = 0;
        export const useEffect = (effect) => effect();
        export const useState = (initial) => [stateCalls++ === 2 ? false : initial, () => {}];
        export const Suspense = ({ children }) => children;
        export const lazy = () => () => null;
        export const createElement = (type, props, ...children) => {
          const element = { type, props: { ...props, children: children.length === 1 ? children[0] : children } };
          return typeof type === "function" ? type(element.props) : element;
        };
        export default { useEffect, useState, Suspense, lazy, createElement };
      `,
      "react/jsx-dev-runtime": `
        export const Fragment = Symbol.for("react.fragment");
        export const jsxDEV = (type, props) => typeof type === "function" ? type(props) : { type, props };
      `,
      "react/jsx-runtime": `
        export const Fragment = Symbol.for("react.fragment");
        export const jsx = (type, props) => typeof type === "function" ? type(props) : { type, props };
        export const jsxs = jsx;
      `,
      "react-i18next": `export const useTranslation = () => ({ t: (key) => key });`,
      "/App.jsx": `export default function App() { return null; }`,
      "/components/AuthenticationStep.tsx": `export default function AuthenticationStep() { return null; }`,
      "/components/MeetingNotificationOverlay.tsx": `export default function Overlay() { return null; }`,
      "/components/UpdateNotificationOverlay.tsx": `export default function Overlay() { return null; }`,
      "/components/WindowControls.tsx": `export default function WindowControls() { return null; }`,
      "/components/ui/card.tsx": `
        export const Card = ({ children }) => children;
        export const CardContent = ({ children }) => children;
      `,
      "/components/onboarding/BackgroundModelDownloadTray.tsx": `export default function Tray() { return null; }`,
      "/components/onboarding/ManagedEnterpriseModelCoordinator.tsx": `export default function Coordinator() { return null; }`,
      "/components/ControlPanel.tsx": `export default function ControlPanel() { return null; }`,
      "/components/OnboardingFlow.tsx": `export default function OnboardingFlow() { return null; }`,
      "/components/EnterpriseReadinessRecovery.tsx": `
        export function EnterpriseReadinessRecovery(props) {
          globalThis.__enterpriseRecoveryProps = props;
          return { type: "recovery" };
        }
      `,
      "/hooks/useAuth": `export const useAuth = () => ({ isSignedIn: true, isGracePeriodOnly: false, isLoaded: true });`,
      "/hooks/useTheme": `export const useTheme = () => {};`,
      "/lib/auth": `
        export const signOut = () => {
          globalThis.__signOuts += 1;
          return Promise.resolve();
        };
      `,
      "/stores/policyStore": `export const usePolicyStore = (selector) => selector({ status: "managed" });`,
      "/stores/workspaceStore": `
        const state = {
          workspaces: [
            { id: "workspace-a", name: "Workspace A" },
            { id: "workspace-b", name: "Workspace B" },
          ],
          activeWorkspaceId: null,
          loaded: true,
          error: false,
          setActiveWorkspaceId: (workspaceId) => {
            globalThis.__selectedWorkspaceId = workspaceId;
          },
          refresh: () => {
            globalThis.__workspaceRefreshes += 1;
            return Promise.resolve();
          },
        };
        export const useWorkspaceStore = Object.assign(
          (selector) => selector(state),
          { getState: () => state }
        );
      `,
      "/stores/enterpriseIdentityStore": `
        export const useEnterpriseIdentityStore = (selector) => selector({ status: "error", verdict: "unknown" });
        export const shouldWaitForEnterpriseReadiness = (signedIn, status, verdict) => signedIn && status === "error" && verdict === "unknown";
      `,
      "/utils/windowContext.ts": `export const isControlPanelWindow = () => true;`,
    },
  });
  const { default: AppRouter } = await vite.ssrLoadModule("/AppRouter.jsx");
  AppRouter();

  assert.deepEqual(calls, [true]);
  assert.equal(typeof globalThis.__enterpriseRecoveryProps?.onRetry, "function");
  assert.equal(typeof globalThis.__enterpriseRecoveryProps?.onSignOut, "function");
  assert.equal(typeof globalThis.__enterpriseRecoveryProps?.onSelectWorkspace, "function");
  assert.deepEqual(globalThis.__enterpriseRecoveryProps?.workspaces, [
    { id: "workspace-a", name: "Workspace A" },
    { id: "workspace-b", name: "Workspace B" },
  ]);
  globalThis.__enterpriseRecoveryProps.onRetry();
  globalThis.__enterpriseRecoveryProps.onSignOut();
  globalThis.__enterpriseRecoveryProps.onSelectWorkspace("workspace-b");
  assert.equal(globalThis.__workspaceRefreshes, 1);
  assert.equal(globalThis.__signOuts, 1);
  assert.equal(globalThis.__selectedWorkspaceId, "workspace-b");
  delete globalThis.__enterpriseRecoveryProps;
  delete globalThis.__workspaceRefreshes;
  delete globalThis.__signOuts;
  delete globalThis.__selectedWorkspaceId;
});
