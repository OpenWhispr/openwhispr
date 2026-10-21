const path = require("node:path");
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

// The elements from the tree's root down to the first one matching `predicate`.
function trailTo(node, predicate, trail = []) {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = trailTo(child, predicate, trail);
      if (found) return found;
    }
    return null;
  }
  if (!node || typeof node !== "object") return null;
  const here = [...trail, node];
  return predicate(node) ? here : trailTo(node.props?.children, predicate, here);
}

// A stand-in DOM node for the last element of `trail`. Like an element, it contains every
// node whose trail runs through it.
const domNode = (trail, page) => ({
  trail,
  ownerDocument: page,
  contains: (other) => Boolean(other && other.trail.includes(trail.at(-1))),
});

/**
 * Runs one Settings panel's real hooks under React's lifecycle with its children left
 * unmounted, as byokStepHarness does for onboarding: the element tree, the settings store
 * and the checks sent are the test boundary. `visible` plays the TabPanel around it. One
 * mount per test context: the mock clock can be enabled only once.
 */
async function mountSettingsPanel(
  t,
  { module, props, settings = {}, secrets = {}, visible = true, electronAPI = {}, fetch } = {}
) {
  let unmount = async () => {};
  // After hooks run in order: unmount while the window still exists, then stop the clock.
  t.after(async () => {
    await unmount();
    t.mock.timers.reset();
  });
  if (fetch) t.mock.method(globalThis, "fetch", fetch);
  const connections = [];
  installBrowserGlobals(t, {
    initialStorage: { ...MIGRATED, ...settings },
    window: {
      location: { search: "" },
      electronAPI: {
        getPlatform: () => "linux",
        // Each automatic check waits here until the test answers it.
        testProviderConnection: (config) =>
          new Promise((resolve) => connections.push({ config, resolve })),
        ...electronAPI,
      },
      dispatchEvent: () => true,
    },
  });
  const container = installHookDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-settings-check-",
    noExternal: ["react-i18next"],
    resolveAlias: { "@": path.resolve(__dirname, "../../src") },
    mockModules: {
      "react-i18next": `
        const t = (key) => key;
        export function useTranslation() { return { t }; }
        export const initReactI18next = { type: "3rdParty", init() {} };
      `,
      "/ui/ProviderIcon": `export function ProviderIcon() { return null; }`,
      // Saving a key clears ReasoningService's key cache through a lazy import.
      "/services/ReasoningService": `export default { clearApiKeyCache() {} };`,
    },
  });
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  useSettingsStore.setState(secrets);
  const { default: Panel } = await vite.ssrLoadModule(module);
  const { PanelVisibleProvider } = await vite.ssrLoadModule("/components/ui/usePanelVisible.ts");
  const { ToastContext } = await vite.ssrLoadModule("/components/ui/useToast.ts");
  t.mock.timers.enable({ apis: ["setTimeout"] });

  let tree;
  let current = props;
  let shown = visible;
  function Harness() {
    tree = Panel(current);
    return null;
  }
  const root = createRoot(container);
  const act = (fn) => React.act(async () => fn());
  const render = () =>
    act(() =>
      root.render(
        React.createElement(
          PanelVisibleProvider,
          { value: shown },
          React.createElement(
            ToastContext.Provider,
            { value: { toast() {} } },
            React.createElement(Harness)
          )
        )
      )
    );
  await render();
  let mounted = true;
  unmount = async () => {
    if (!mounted) return;
    mounted = false;
    await act(() => root.unmount());
  };

  const find = (predicate) => findAll(tree, predicate);
  const named = (name) => (node) => node.props?.["aria-label"] === name;
  const field = (name) => find(named(name))[0];
  const checkField = () => find((node) => node.props?.check)[0];

  let focused = null;
  // A focus event reaches the field's own handler, then each element around it, innermost
  // first, as React's do. Component elements are skipped: their handlers belong to
  // children that are not mounted.
  const dispatch = (name, type, { to = null, windowSwitch = false } = {}) =>
    act(() => {
      const page = { activeElement: null };
      const trail = trailTo(tree, named(name));
      const target = domNode(trail, page);
      // windowSwitch: the window lost focus, but the field is still the page's focus.
      if (windowSwitch) page.activeElement = target;
      const relatedTarget = to ? domNode(trailTo(tree, named(to)), page) : null;
      for (let depth = trail.length - 1; depth >= 0; depth -= 1) {
        const element = trail[depth];
        const handler = element.props?.[type];
        const host = typeof element.type === "string";
        if (typeof handler !== "function" || (depth < trail.length - 1 && !host)) continue;
        const currentTarget = domNode(trail.slice(0, depth + 1), page);
        handler({ target, relatedTarget, currentTarget });
      }
    });
  const blur = async (name, { windowSwitch = false, to = null } = {}) => {
    await dispatch(name, "onBlur", { to, windowSwitch });
    if (!windowSwitch) focused = null;
  };
  // Focus moving between fields blurs the first, with the second as relatedTarget, then
  // focuses the second, as the browser does.
  const focus = async (name) => {
    if (focused && focused !== name) await blur(focused, { to: name });
    focused = name;
    await dispatch(name, "onFocus");
  };
  // A tab, a model card or an option takes focus away from the fields.
  const leaveFields = async () => {
    if (focused) await blur(focused);
  };

  return {
    state: () => useSettingsStore.getState(),
    setStore: (patch) => act(() => useSettingsStore.setState(patch)),
    setProps: (patch) => {
      current = { ...current, ...patch };
      return render();
    },
    setVisible: (value) => {
      shown = value;
      return render();
    },
    unmount,
    find,
    field,
    checkField,
    phase: () => checkField()?.props.check.phase,
    focus,
    blur,
    // Typing needs the field's focus, so a field not yet focused is focused first.
    type: async (name, value) => {
      if (focused !== name) await focus(name);
      await act(() => field(name).props.onChange({ target: { value } }));
    },
    selectTab: async (id) => {
      await leaveFields();
      const tabs = find((node) => node.props?.providers?.some?.((tab) => tab.id === id))[0];
      await act(() => tabs.props.onSelect(id));
    },
    choose: async (value) => {
      await leaveFields();
      const select = find((node) => typeof node.props?.onValueChange === "function")[0];
      await act(() => select.props.onValueChange(value));
    },
    requests: () => connections.map((connection) => connection.config),
    answer: (result, index = connections.length - 1) =>
      act(() => connections[index].resolve(result)),
    retry: () => act(() => checkField().props.check.retry()),
    wait: (ms) => act(() => t.mock.timers.tick(ms)),
    announcement: () =>
      find((node) => node.props && "announcement" in node.props)[0]?.props.announcement,
  };
}

module.exports = { mountSettingsPanel };
