const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("./rendererTestHarness");

const MIGRATED = { _providerSettingsMigrated: "1", uploadTranscriptionMigrated: "true" };
const ENDPOINT_PLACEHOLDER = "onboarding.rehaul.provider.endpointPlaceholder";

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
  let unmount = async () => {};
  // After hooks run in order: unmount while the window still exists, then stop the mock
  // clock before the renderer server closes.
  t.after(async () => {
    await unmount();
    t.mock.timers.reset();
  });
  const connections = [];
  installBrowserGlobals(t, {
    initialStorage: { ...MIGRATED, ...settings },
    window: {
      electronAPI: {
        getPlatform: () => "linux",
        // Each automatic check waits here until the test answers it.
        testProviderConnection: (config) =>
          new Promise((resolve) => connections.push({ config, resolve })),
      },
      dispatchEvent: () => true,
    },
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
  const { CONNECTION_CHECK_DELAY_MS } = await vite.ssrLoadModule(
    "/hooks/useConnectionAutoCheck.ts"
  );
  // The step's timers run on a mock clock. Anything still pending when the test ends (a
  // key's secret write, a draft flush) is dropped rather than waited out. One mount per
  // test context: the clock can be enabled only once.
  t.mock.timers.enable({ apis: ["setTimeout"] });

  let proceeded = 0;

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
      onProceed: () => {
        proceeded += 1;
      },
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
  const wait = (ms) => act(() => t.mock.timers.tick(ms));
  const answerConnection = (result, index = connections.length - 1) =>
    act(() => connections[index].resolve(result));
  const checkField = (label) => find((node) => node.props?.check && node.props.label === label)[0];
  const endpoint = () => input(ENDPOINT_PLACEHOLDER);
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
    connectionRequests: () => connections.map((connection) => connection.config),
    wait,
    answerConnection,
    // The step checks by itself: wait out the pause, then answer the request it sent.
    passConnectionTest: async () => {
      const sent = connections.length;
      await wait(CONNECTION_CHECK_DELAY_MS);
      assert.equal(connections.length, sent + 1, "the step sends one check after the pause");
      await answerConnection({ success: true });
    },
    checkField,
    retryCheck: (label) => act(() => checkField(label).props.check.retry()),
    liveRegion: () => find((node) => node.props?.role === "status")[0],
    focusEndpoint: () => act(() => endpoint().props.onFocus()),
    // windowSwitch: the window lost focus but the field is still the page's focus.
    blurEndpoint: ({ windowSwitch = false } = {}) =>
      act(() => {
        const field = {};
        field.ownerDocument = { activeElement: windowSwitch ? field : null };
        endpoint().props.onBlur({ currentTarget: field });
      }),
    proceedDisabled: () => proceedButton().props.disabled,
    proceed: () => act(() => proceedButton().props.onClick()),
    proceeded: () => proceeded,
    // Unmounting flushes the debounced draft write, as advancing past the step does.
    unmountForDrafts: async () => {
      await unmount();
      return drafts;
    },
  };
}

module.exports = { mountByokStep };
