const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("./rendererTestHarness");

const MIGRATED = { _providerSettingsMigrated: "1", uploadTranscriptionMigrated: "true" };

function findAll(node, predicate, found = []) {
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, found);
  } else if (node && typeof node === "object") {
    if (predicate(node)) found.push(node);
    findAll(node.props?.children, predicate, found);
  }
  return found;
}

/**
 * Mounts the onboarding BYOK step with the real component and hooks under React's
 * lifecycle, leaving native controls unmounted: the returned element tree, the
 * settings store and the persisted draft are the test boundary.
 */
async function mountByokStep(
  t,
  {
    stepId = "byok-dictation",
    selfHostedRequested = false,
    resumeState,
    settings = {},
    secrets = {},
  } = {}
) {
  // Registered first so it runs first: after hooks run in order, and unmounting once
  // the globals are gone would run the step's cleanup without a window.
  let unmount = async () => {};
  t.after(() => unmount());
  // Saving a key schedules its secret write and a .env persist; those would run
  // against a window that is already gone, so whatever is still pending is dropped
  // rather than waited out.
  const pendingTimers = new Set();
  const { setTimeout: realSetTimeout, clearTimeout: realClearTimeout } = globalThis;
  globalThis.setTimeout = (...args) => {
    const id = realSetTimeout(...args);
    pendingTimers.add(id);
    return id;
  };
  globalThis.clearTimeout = (id) => {
    pendingTimers.delete(id);
    realClearTimeout(id);
  };
  t.after(() => {
    for (const id of pendingTimers) realClearTimeout(id);
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  });
  installBrowserGlobals(t, {
    initialStorage: { ...MIGRATED, ...settings },
    window: { electronAPI: { getPlatform: () => "linux" }, dispatchEvent: () => true },
  });
  const container = installHookDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-byok-step-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `
        const t = (key) => key;
        export function useTranslation() { return { t }; }
        export const initReactI18next = { type: "3rdParty", init() {} };
      `,
      "/ProviderConnectionTest": `export default function ProviderConnectionTest() { return null; }`,
      "/OnboardingShell": `export function BrandMark() { return null; }`,
      "/ui/ProviderIcon": `export function ProviderIcon() { return null; }`,
      // Saving a key clears ReasoningService's key cache through a lazy import.
      "/services/ReasoningService": `export default { clearApiKeyCache() {} };`,
    },
  });
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  useSettingsStore.setState(secrets);
  const { ByokProviderStep } = await vite.ssrLoadModule(
    "/components/onboarding/ProviderSetupStep.tsx"
  );

  let tree;
  const drafts = [];
  const selfHostedChanges = [];
  function Harness() {
    tree = ByokProviderStep({
      stepId,
      selfHostedRequested,
      resumeState,
      onSelfHostedChange: (requested) => selfHostedChanges.push(requested),
      onConnectionChange() {},
      onProceed() {},
      onResumeStateChange: (draft) => drafts.push(draft),
    });
    return null;
  }
  const root = createRoot(container);
  await React.act(async () => root.render(React.createElement(Harness)));
  let mounted = true;
  unmount = async () => {
    if (!mounted) return;
    mounted = false;
    await React.act(async () => root.unmount());
  };

  const find = (predicate) => findAll(tree, predicate);
  const input = (placeholder) => find((node) => node.props?.placeholder === placeholder)[0];
  const act = (fn) => React.act(async () => fn());
  const proceedButton = () =>
    find((node) => node.props?.children === "onboarding.rehaul.provider.proceed")[0];
  return {
    vite,
    selfHostedChanges,
    state: () => useSettingsStore.getState(),
    setStore: (patch) => act(() => useSettingsStore.setState(patch)),
    value: (placeholder) => input(placeholder)?.props.value,
    type: (placeholder, value) =>
      act(() => input(placeholder).props.onChange({ target: { value } })),
    // [provider, model] in the hosted half; absent while the card is self-hosted.
    selectValues: () =>
      find((node) => typeof node.props?.onValueChange === "function").map(
        (node) => node.props.value
      ),
    toggleSelfHosted: () =>
      act(() => find((node) => node.props?.role === "checkbox")[0].props.onClick()),
    chooseProvider: (providerId) =>
      act(() =>
        find((node) => typeof node.props?.onValueChange === "function")[0].props.onValueChange(
          providerId
        )
      ),
    passConnectionTest: () =>
      act(() =>
        find((node) => typeof node.props?.onSuccessChange === "function")[0].props.onSuccessChange(
          true
        )
      ),
    proceedDisabled: () => proceedButton().props.disabled,
    proceed: () => act(() => proceedButton().props.onClick()),
    // Unmounting flushes the debounced draft write, as advancing past the step does.
    unmountForDrafts: async () => {
      await unmount();
      return drafts;
    },
  };
}

module.exports = { mountByokStep };
