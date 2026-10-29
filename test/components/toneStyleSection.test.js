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

async function renderSection(t, settings, props = {}) {
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
  await React.act(async () =>
    root.render(React.createElement(ToneStyleSection, { onOpenCleanupSettings() {}, ...props }))
  );
  return { container, store: useSettingsStore };
}

const DEFAULTS = { personal: "casual", work: "formal", email: "formal", other: "formal" };

const hasText = (root, text) => !!findElement(root, (element) => element.textContent === text);
const enabledToggle = (root) =>
  findElement(root, (element) => element.getAttribute?.("role") === "switch");
// Off, the picks stay on screen but can't be changed.
const picksEnabled = (root) =>
  !isDisabled(
    button(
      findElement(root, (e) => e.getAttribute?.("role") === "group"),
      "toneStyle.tones.formal"
    )
  );

test("Tones & voices stays off until it is turned on, which applies the saved picks", async (t) => {
  const { container, store } = await renderSection(t, {
    useCleanupModel: true,
    toneStyleEnabled: false,
    toneStyles: DEFAULTS,
  });
  assert.equal(enabledToggle(container).getAttribute("aria-checked"), "false");
  assert.equal(picksEnabled(container), false);
  assert.equal(isDisabled(button(container, "toneStyle.settings.saveChanges")), true);

  await React.act(async () => click(enabledToggle(container)));
  assert.equal(store.getState().toneStyleEnabled, true);
  assert.deepEqual(store.getState().toneStyles, DEFAULTS);
  // Home stops offering it, even after a switch back.
  assert.equal(localStorage.getItem("toneStyleBannerDismissed"), "true");
  assert.equal(enabledToggle(container).getAttribute("aria-checked"), "true");
  assert.equal(picksEnabled(container), true);
  assert.equal(isDisabled(button(container, "toneStyle.settings.saveChanges")), true);

  await React.act(async () => click(enabledToggle(container)));
  assert.equal(store.getState().toneStyleEnabled, false);
  assert.equal(picksEnabled(container), false);
});

test("once set up, Save waits for a changed pick and saves it", async (t) => {
  const { container, store } = await renderSection(t, {
    useCleanupModel: true,
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

test("with cleanup off, the section says so and turns it on", async (t) => {
  let opened = 0;
  const { container, store } = await renderSection(
    t,
    {
      useCleanupModel: false,
      toneStyleEnabled: true,
      toneStyles: DEFAULTS,
      isSignedIn: true,
      cleanupMode: "openwhispr",
      cleanupCloudMode: "openwhispr",
    },
    { onOpenCleanupSettings: () => opened++ }
  );
  assert.ok(hasText(container, "toneStyle.settings.cleanupOff"));

  await React.act(async () => click(button(container, "toneStyle.settings.turnOnCleanup")));
  assert.equal(store.getState().useCleanupModel, true);
  assert.equal(hasText(container, "toneStyle.settings.cleanupOff"), false);
  // Cloud cleanup needs no model, so the user stays here.
  assert.equal(opened, 0);
});

test("turning cleanup on without a usable model opens its settings", async (t) => {
  let opened = 0;
  const { container, store } = await renderSection(
    t,
    {
      useCleanupModel: false,
      toneStyleEnabled: true,
      toneStyles: DEFAULTS,
      isSignedIn: false,
      cleanupMode: "providers",
      cleanupProvider: "openai",
      cleanupModel: "",
    },
    { onOpenCleanupSettings: () => opened++ }
  );

  await React.act(async () => click(button(container, "toneStyle.settings.turnOnCleanup")));
  assert.equal(store.getState().useCleanupModel, true);
  assert.equal(opened, 1);
});
