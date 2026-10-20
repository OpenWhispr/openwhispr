const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const React = require("react");
const { createRoot } = require("react-dom/client");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { installInteractiveDom, findElement } = require("../lib/interactiveDom");

const MOCKS = {
  "react-i18next": `
    const t = (key) => key;
    export const useTranslation = () => ({ t, i18n: { language: "en" } });
    export const initReactI18next = { type: "3rdParty", init() {} };
    export const Trans = ({ i18nKey }) => i18nKey;
  `,
  // The real tabs measure their buttons, which this DOM has no layout for.
  "/ui/ProviderTabs": `
    export const ProviderTabs = () => null;
  `,
};

function dispatch(element, type, extra = {}) {
  element.dispatchEvent({
    type,
    bubbles: true,
    defaultPrevented: false,
    cancelBubble: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {
      this.cancelBubble = true;
    },
    ...extra,
  });
}

async function renderPicker(t, { provider = "anthropic", model = "claude-fable-5-1" } = {}) {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  installBrowserGlobals(t, {
    initialStorage: { _llmScopeKeysMigrated: "1" },
    window: { electronAPI: {} },
  });
  const container = installInteractiveDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-reasoning-typed-model-id-test-",
    noExternal: ["react-i18next"],
    mockModules: MOCKS,
    resolveAlias: { "@": path.resolve(__dirname, "../../src") },
  });
  const { default: ReasoningModelSelector } = await vite.ssrLoadModule(
    "/components/ReasoningModelSelector.tsx"
  );
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");

  const commits = [];
  const props = {
    reasoningModel: model,
    localReasoningProvider: provider,
    cloudReasoningBaseUrl: "",
    setCloudReasoningBaseUrl: () => {},
    mode: "cloud",
  };
  const render = () =>
    React.act(async () => root.render(React.createElement(ReasoningModelSelector, props)));
  props.setLocalReasoningProvider = (value) => {
    props.localReasoningProvider = value;
    commits.push(["provider", value]);
  };
  props.setReasoningModel = (value) => {
    props.reasoningModel = value;
    commits.push(["model", value]);
  };

  root = createRoot(container);
  await render();
  const input = () =>
    findElement(
      container,
      (element) =>
        element.tagName === "INPUT" &&
        element.getAttribute("placeholder") === "reasoning.typedModelId.placeholder"
    );
  const typeAndCommit = async (value, commitEvent) => {
    await React.act(async () => {
      input().value = value;
      dispatch(input(), "input");
    });
    await React.act(async () => {
      if (commitEvent === "enter") dispatch(input(), "keydown", { key: "Enter" });
      else dispatch(input(), "focusout");
    });
    await render();
  };
  return { input, typeAndCommit, commits, state: () => useSettingsStore.getState() };
}

test("a typed Anthropic model id commits on blur and is remembered", async (t) => {
  const picker = await renderPicker(t);
  assert.ok(picker.input(), "the Anthropic tab offers a model id field");
  assert.equal(picker.input().value, "", "a listed model leaves the field empty");

  await picker.typeAndCommit("  claude-opus-9  ");

  assert.deepEqual(picker.commits, [
    ["provider", "anthropic"],
    ["model", "claude-opus-9"],
  ]);
  assert.deepEqual(picker.state().customReasoningModelIds, { anthropic: ["claude-opus-9"] });
  assert.equal(picker.input().value, "claude-opus-9", "the field shows the typed selection");
});

test("Enter commits too, and typing does not save a partial id", async (t) => {
  const picker = await renderPicker(t);
  await React.act(async () => {
    picker.input().value = "claude-son";
    dispatch(picker.input(), "input");
  });
  assert.deepEqual(picker.commits, [], "nothing is saved while typing");

  await picker.typeAndCommit("claude-sonnet-9", "enter");
  assert.deepEqual(picker.commits, [
    ["provider", "anthropic"],
    ["model", "claude-sonnet-9"],
  ]);

  await picker.typeAndCommit("claude-sonnet-9");
  assert.equal(picker.commits.length, 2, "the blur after Enter commits nothing new");
});

test("typing a listed model id selects it without recording it", async (t) => {
  const picker = await renderPicker(t, { model: "claude-sonnet-5" });
  await picker.typeAndCommit("claude-fable-5-1");

  assert.deepEqual(picker.commits.at(-1), ["model", "claude-fable-5-1"]);
  assert.deepEqual(picker.state().customReasoningModelIds, {});
  assert.equal(picker.input().value, "", "the card shows the selection, not the field");
});

test("a blank commit changes nothing", async (t) => {
  const picker = await renderPicker(t);
  await picker.typeAndCommit("   ");
  assert.deepEqual(picker.commits, []);
});

test("providers without typed ids show no field", async (t) => {
  const picker = await renderPicker(t, { provider: "openai", model: "gpt-5.2" });
  assert.equal(picker.input(), null);
});
