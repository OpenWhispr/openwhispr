const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

const I18N_MOCK = `
  import en from '/locales/en/translation.json';
  const t = (key, values = {}) => {
    let s = key.split('.').reduce((v, k) => v?.[k], en) ?? key;
    return String(s).replace(/{{(\\w+)}}/g, (_, k) => values[k] ?? '');
  };
  export const useTranslation = () => ({ t, i18n: { language: 'en' } });
`;

test("dictation panel surfaces toast and openSettings action when control panel is not visible", async (t) => {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    delete globalThis.__gpuToasts;
  });

  globalThis.__gpuToasts = [];
  let shownDictationPanel = false;
  let dismissedNotice = false;
  let openedSection = null;

  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        isControlPanelVisible: async () => false,
        getGpuPackMigrationNotice: async () => ({ packs: ["CUDA whisper"] }),
        showDictationPanel: async () => {
          shownDictationPanel = true;
        },
        dismissGpuPackMigrationNotice: async () => {
          dismissedNotice = true;
          return { success: true };
        },
        openSettingsSection: async (section) => {
          openedSection = section;
          return { success: true };
        },
      },
    },
  });

  const container = installHookDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-gpu-toast-listener-test-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": I18N_MOCK,
      "/ui/useToast": `
        export const useToast = () => ({
          toast: (props) => globalThis.__gpuToasts.push(props)
        });
      `,
      "/utils/windowContext": `
        export const isDictationPanelWindow = () => true;
      `,
    },
  });

  const { default: GpuPackMigrationToastListener } = await vite.ssrLoadModule(
    "/components/GpuPackMigrationToastListener.tsx"
  );

  root = createRoot(container);
  await React.act(async () => {
    root.render(React.createElement(GpuPackMigrationToastListener));
  });

  // Allow the 800ms cold-start delay in dictation panel
  await new Promise((resolve) => setTimeout(resolve, 950));

  assert.equal(shownDictationPanel, true, "surfaced dictation panel");
  assert.equal(dismissedNotice, true, "dismissed the notice");
  assert.equal(globalThis.__gpuToasts.length, 1, "toasted exactly once");

  const toastProps = globalThis.__gpuToasts[0];
  assert.match(toastProps.description, /CUDA whisper/);
  assert.ok(toastProps.actions?.length > 0, "has settings action");

  // Test action opens speechToText
  await toastProps.actions[0].onClick();
  assert.equal(openedSection, "speechToText");
});

test("dictation panel does not toast when control panel is already visible", async (t) => {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    delete globalThis.__gpuToasts;
  });

  globalThis.__gpuToasts = [];
  let shownDictationPanel = false;

  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        isControlPanelVisible: async () => true,
        getGpuPackMigrationNotice: async () => ({ packs: ["CUDA whisper"] }),
        showDictationPanel: async () => {
          shownDictationPanel = true;
        },
        dismissGpuPackMigrationNotice: async () => ({ success: true }),
      },
    },
  });

  const container = installHookDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-gpu-toast-listener-test-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": I18N_MOCK,
      "/ui/useToast": `
        export const useToast = () => ({
          toast: (props) => globalThis.__gpuToasts.push(props)
        });
      `,
      "/utils/windowContext": `
        export const isDictationPanelWindow = () => true;
      `,
    },
  });

  const { default: GpuPackMigrationToastListener } = await vite.ssrLoadModule(
    "/components/GpuPackMigrationToastListener.tsx"
  );

  root = createRoot(container);
  await React.act(async () => {
    root.render(React.createElement(GpuPackMigrationToastListener));
  });

  await new Promise((resolve) => setTimeout(resolve, 950));

  assert.equal(shownDictationPanel, false);
  assert.equal(globalThis.__gpuToasts.length, 0);
});

test("control panel toasts immediately without waiting or calling showDictationPanel", async (t) => {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    delete globalThis.__gpuToasts;
  });

  globalThis.__gpuToasts = [];
  let shownDictationPanel = false;
  let dismissedNotice = false;

  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        getGpuPackMigrationNotice: async () => ({ packs: ["Vulkan whisper"] }),
        showDictationPanel: async () => {
          shownDictationPanel = true;
        },
        dismissGpuPackMigrationNotice: async () => {
          dismissedNotice = true;
          return { success: true };
        },
      },
    },
  });

  const container = installHookDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-gpu-toast-listener-test-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": I18N_MOCK,
      "/ui/useToast": `
        export const useToast = () => ({
          toast: (props) => globalThis.__gpuToasts.push(props)
        });
      `,
      "/utils/windowContext": `
        export const isDictationPanelWindow = () => false;
      `,
    },
  });

  const { default: GpuPackMigrationToastListener } = await vite.ssrLoadModule(
    "/components/GpuPackMigrationToastListener.tsx"
  );

  root = createRoot(container);
  await React.act(async () => {
    root.render(React.createElement(GpuPackMigrationToastListener));
  });

  // Control panel toasts immediately (microtask)
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(shownDictationPanel, false, "control panel never calls showDictationPanel");
  assert.equal(dismissedNotice, true, "dismissed the notice");
  assert.equal(globalThis.__gpuToasts.length, 1, "toasted immediately");
  assert.match(globalThis.__gpuToasts[0].description, /Vulkan whisper/);
});
