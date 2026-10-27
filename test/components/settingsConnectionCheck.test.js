const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const { mountAuditDom, deferred } = require("../lib/settingsAuditHarness");

async function load(t) {
  installBrowserGlobals(t);
  return createRendererServer(t, {
    cachePrefix: "openwhispr-settings-check-plumbing-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `
        const t = (key) => key;
        export function useTranslation() { return { t }; }
      `,
    },
  });
}

test("a TabPanel hides its panel, and a nested one shows only while all are active", async (t) => {
  const vite = await load(t);
  const { TabPanel } = await vite.ssrLoadModule("/components/ui/TabPanel.tsx");
  const { usePanelVisible } = await vite.ssrLoadModule("/components/ui/usePanelVisible.ts");
  function Probe() {
    return React.createElement("i", null, usePanelVisible() ? "shown" : "held");
  }
  const nest = (outer, inner) =>
    renderToStaticMarkup(
      React.createElement(
        TabPanel,
        { active: outer },
        React.createElement(TabPanel, { active: inner }, React.createElement(Probe))
      )
    );
  assert.equal(renderToStaticMarkup(React.createElement(Probe)), "<i>shown</i>");
  assert.equal(nest(true, true), "<div><div><i>shown</i></div></div>");
  assert.equal(nest(true, false), '<div><div hidden=""><i>held</i></div></div>');
  assert.equal(nest(false, true), '<div hidden=""><div><i>held</i></div></div>');
});

test("the announcer is there from the start and says only what the check found", async (t) => {
  const vite = await load(t);
  const { ConnectionCheckAnnouncer } = await vite.ssrLoadModule(
    "/components/ui/ConnectionCheckAnnouncer.tsx"
  );
  const say = (announcement) =>
    renderToStaticMarkup(React.createElement(ConnectionCheckAnnouncer, { announcement }));
  assert.equal(
    say(null),
    '<div role="status" aria-live="polite" aria-atomic="true" class="sr-only"></div>'
  );
  for (const announcement of ["testing", "connected"]) {
    const spoken = `class="sr-only">onboarding.rehaul.provider.${announcement}</div>`;
    assert.ok(say(announcement).endsWith(spoken), announcement);
  }
});

test("retained LLM editors share ancestor visibility, keep credential drafts and reject old checks", async (t) => {
  const { dom, container, render } = await mountAuditDom(t);
  const requests = [];
  const saved = [];
  dom.electronAPI = {
    getPlatform: () => "darwin",
    testProviderConnection: (config) => {
      const request = { ...deferred(), config };
      requests.push(request);
      return request.promise;
    },
    saveOpenAIKey: async (key) => {
      saved.push(key);
      return { success: true };
    },
    saveAllKeysToEnv: async () => ({}),
  };
  const vite = await createRendererServer(t, {
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `const t = key => key; export const useTranslation = () => ({t}); export const initReactI18next = {type: "3rdParty", init() {}};`,
      "/hooks/usePolicy": `const policy = {status: "unmanaged", policy: null}; export const usePolicySnapshot = () => policy; export const usePolicyModeOptions = (modes, _scope, current) => ({modes, effectiveMode: current, isModeAllowed: () => true});`,
      "/settings/GpuDeviceSelector": `export default () => null;`,
      "/ui/PromptStudio": `export default () => null;`,
      "/ui/useToast": `const value = {toast() {}}; export const useToast = () => value;`,
      // Keep the production editors and their hooks mounted. Only the leaf input's
      // event adapter changes, so Happy DOM can deliver native input events.
      "/ui/ProviderCheckField": `import React from "react"; export const ProviderCheckField = props => React.createElement("input", {"aria-label": props["aria-label"], value: props.value, onInput: props.onChange, onBlur: props.onBlur});`,
    },
  });
  const { useSettingsStore: store } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  usePolicyStore.setState({ status: "unmanaged", policy: null });
  store.setState({
    useCleanupModel: true,
    cleanupMode: "providers",
    cleanupProvider: "openai",
    cleanupModel: "gpt-5-mini",
    openaiApiKey: "saved-key",
    noteFormattingMode: "providers",
    noteFormattingProvider: "openai",
    noteFormattingModel: "gpt-4.1",
  });
  const { createSettingsNavigationStore } = await vite.ssrLoadModule(
    "/stores/settingsNavigationStore.ts"
  );
  const { default: Llms } = await vite.ssrLoadModule("/components/settings/LlmsSection.tsx");
  const { TabPanel } = await vite.ssrLoadModule("/components/settings/KeepAlive.tsx");
  const navigation = createSettingsNavigationStore("llms");
  const editor = React.createElement(Llms, { navigation });
  const show = (active) => render(React.createElement(TabPanel, { active }, editor));
  const wait = (ms) => React.act(async () => new Promise((resolve) => setTimeout(resolve, ms)));
  const settle = (index, result) => React.act(async () => requests[index].resolve(result));
  await show(true);
  await wait(0);
  assert.equal(requests.length, 1);
  const input = container.querySelector('input[aria-label="common.apiKey"]');
  assert.ok(input);
  for (let i = 1; i <= 24; i++) {
    await React.act(async () => {
      input.value = "x".repeat(i);
      input.dispatchEvent(new dom.Event("input", { bubbles: true }));
    });
  }
  assert.deepEqual(saved, [], "24 keystrokes publish no credentials");
  assert.equal(store.getState().openaiApiKey, "saved-key");
  await settle(0, { success: true });
  assert.deepEqual(saved, [], "an old check cannot publish a newer draft");
  await React.act(async () => navigation.getState().selectLlmTab("noteFormatting"));
  await wait(0);
  assert.equal(requests.length, 2, "only the newly visible editor checks");
  await show(false);
  await React.act(async () => store.setState({ openaiApiKey: "another-window" }));
  await wait(550);
  assert.equal(requests.length, 2, "an active inner tab is hidden by its outer owner");
  await settle(1, { success: true });
  assert.deepEqual(saved, [], "a hidden obsolete response cannot publish");
  await show(true);
  await wait(0);
  assert.equal(requests.length, 3, "showing restores checks");
  await settle(2, { success: true });
  await React.act(async () => navigation.getState().selectLlmTab("dictationCleanup"));
  assert.strictEqual(container.querySelector('input[aria-label="common.apiKey"]'), input);
  assert.equal(input.value, "x".repeat(24), "retained editor keeps its local draft");
  await wait(0);
  assert.equal(requests.at(-1).config.apiKey, "x".repeat(24));
  await settle(requests.length - 1, { success: true });
  assert.deepEqual(saved, ["x".repeat(24)], "one accepted change publishes once");
  await render(null);
});
