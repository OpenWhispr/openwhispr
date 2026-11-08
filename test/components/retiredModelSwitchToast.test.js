const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

const QUEUE_KEY = "retiredModelSwitchesQueue";
const EVENT = { provider: "openai", providerName: "OpenAI", from: "GPT-5.5", to: "GPT-6 Luna" };

async function mount(t, { search = "?panel=true", focused = true, queued = [EVENT] } = {}) {
  let root;
  const toasts = [];
  const shown = [];
  globalThis.__retired = { toasts };
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    delete globalThis.__retired;
  });
  const windowListeners = new Map();
  const { storage } = installBrowserGlobals(t, {
    initialStorage: queued.length ? { [QUEUE_KEY]: JSON.stringify(queued) } : {},
    window: {
      location: { search },
      addEventListener: (type, listener) => windowListeners.set(type, listener),
      removeEventListener: (type) => windowListeners.delete(type),
      electronAPI: { showDictationPanel: () => shown.push(true) },
    },
  });
  const container = installHookDom(t);
  let hasFocus = focused;
  Object.assign(globalThis.document, {
    visibilityState: "visible",
    hasFocus: () => hasFocus,
    addEventListener() {},
    removeEventListener() {},
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-retired-toast-test-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `
        export const useTranslation = () => ({
          t: (key, values) => (values ? key + " " + JSON.stringify(values) : key),
        });
      `,
      "/ui/useToast": `
        export const useToast = () => ({
          toast: (props) => globalThis.__retired.toasts.push(props),
        });
      `,
    },
  });
  const store = await vite.ssrLoadModule("/stores/retiredModelSwitchStore.ts");
  const { default: Listener } = await vite.ssrLoadModule(
    "/components/RetiredModelSwitchToastListener.tsx"
  );
  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(Listener)));
  const focus = () =>
    React.act(async () => {
      hasFocus = true;
      windowListeners.get("focus")?.();
    });
  return { toasts, shown, storage, store, windowListeners, focus };
}

test("a focused control panel shows what another window queued, once", async (t) => {
  const { toasts, storage } = await mount(t);
  assert.equal(toasts.length, 1);
  assert.match(toasts[0].description, /^reasoning\.openai\.modelRetired /);
  assert.match(toasts[0].description, /GPT-6 Luna/);
  assert.equal(storage.getItem(QUEUE_KEY), null);
});

test("a panel in the tray keeps the toast until the user is there to read it", async (t) => {
  const { toasts, storage, focus } = await mount(t, { focused: false });
  assert.equal(toasts.length, 0, "a hidden panel still reports itself visible, but has no focus");
  assert.ok(storage.getItem(QUEUE_KEY));
  await focus();
  assert.equal(toasts.length, 1);
});

test("the dictation window leaves the queue alone and doesn't surface the pill", async (t) => {
  const { toasts, shown, storage, store } = await mount(t, { search: "" });
  await React.act(async () => {
    store.queueRetiredModelSwitch({ ...EVENT, from: "GPT-5.2" });
  });
  assert.equal(toasts.length, 0);
  assert.equal(shown.length, 0);
  assert.equal(JSON.parse(storage.getItem(QUEUE_KEY)).length, 2);
});

test("a move made in this panel, or in another window while it is open, shows at once", async (t) => {
  const { toasts, store, storage, windowListeners } = await mount(t, { queued: [] });
  await React.act(async () => store.queueRetiredModelSwitch(EVENT));
  assert.equal(toasts.length, 1);
  storage.setItem(QUEUE_KEY, JSON.stringify([{ ...EVENT, from: "GPT-5.2" }]));
  await React.act(async () =>
    windowListeners.get("storage")({ key: QUEUE_KEY, newValue: storage.getItem(QUEUE_KEY) })
  );
  assert.equal(toasts.length, 2);
});

test("an event may carry its own message", async (t) => {
  const { toasts } = await mount(t, {
    queued: [{ ...EVENT, messageKey: "reasoning.modelUnavailableSwitched" }],
  });
  assert.match(toasts[0].description, /^reasoning\.modelUnavailableSwitched /);
});
