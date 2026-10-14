const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { installInteractiveDom, findElement } = require("../lib/interactiveDom");

const MOCKS = {
  "react-i18next": `
    const t = (key) => key;
    export const useTranslation = () => ({ t, i18n: { language: "en" } });
    export const initReactI18next = { type: "3rdParty", init() {} };
  `,
  "/ui/useToast": `
    export const useToast = () => ({ toast() {} });
  `,
};

const click = (element) =>
  element.dispatchEvent({
    type: "click",
    bubbles: true,
    button: 0,
    defaultPrevented: false,
    cancelBubble: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {
      this.cancelBubble = true;
    },
  });

// No i18next instance is initialized, so labels render as their keys.
function button(root, label) {
  const found = findElement(
    root,
    (element) => element.tagName === "BUTTON" && element.textContent === label
  );
  assert.ok(found, `button ${label} is rendered`);
  return found;
}

const isDisabled = (element) => element.getAttribute("disabled") !== null;

async function renderSection(t, settings) {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  installBrowserGlobals(t, { window: { electronAPI: {} } });
  const container = installInteractiveDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-tone-style-section-test-",
    noExternal: ["react-i18next"],
    mockModules: MOCKS,
  });
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  useSettingsStore.setState(settings);
  const { default: ToneStyleSection } = await vite.ssrLoadModule(
    "/components/settings/ToneStyleSection.tsx"
  );
  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(ToneStyleSection)));
  return { container, store: useSettingsStore };
}

const DEFAULTS = { personal: "casual", work: "formal", email: "formal", other: "formal" };

test("before Tone & Style is set up, saving the picks as they are turns it on", async (t) => {
  const { container, store } = await renderSection(t, {
    toneStyleEnabled: false,
    toneStyles: DEFAULTS,
  });
  const save = button(container, "toneStyle.settings.saveChanges");
  assert.equal(isDisabled(save), false);

  await React.act(async () => click(save));
  assert.equal(store.getState().toneStyleEnabled, true);
  assert.deepEqual(store.getState().toneStyles, DEFAULTS);
  assert.equal(isDisabled(save), true);
});

test("once set up, Save waits for a changed pick and saves it", async (t) => {
  const { container, store } = await renderSection(t, {
    toneStyleEnabled: true,
    toneStyles: DEFAULTS,
  });
  const save = button(container, "toneStyle.settings.saveChanges");
  assert.equal(isDisabled(save), true);

  const work = findElement(
    container,
    (element) => element.getAttribute?.("aria-label") === "toneStyle.categories.work.title"
  );
  await React.act(async () => click(button(work, "toneStyle.tones.casual")));
  assert.equal(isDisabled(save), false);

  await React.act(async () => click(save));
  assert.equal(store.getState().toneStyles.work, "casual");
  assert.equal(store.getState().toneStyleEnabled, true);
});
