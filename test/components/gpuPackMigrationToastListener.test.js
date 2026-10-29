const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

// Main hands the notice out once (take) to the window that should show it.
async function mountListener(t, { controlPanel, notice = { packs: ["CUDA whisper"] } }) {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    delete globalThis.__gpuToasts;
  });
  globalThis.__gpuToasts = [];
  const calls = { takes: 0, shownDictationPanel: 0, openedSection: null, notifyReady: null };
  let remaining = notice;
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        takeGpuPackMigrationNotice: async () => {
          calls.takes += 1;
          const taken = remaining;
          remaining = null;
          return taken;
        },
        onGpuPackMigrationNoticeReady: (callback) => {
          calls.notifyReady = callback;
          return () => {
            calls.notifyReady = null;
          };
        },
        showDictationPanel: async () => {
          calls.shownDictationPanel += 1;
        },
        openSettingsSection: async (section) => {
          calls.openedSection = section;
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
      "react-i18next": `
        export const useTranslation = () => ({
          t: (key, values) => (values ? key + " " + JSON.stringify(values) : key),
        });
      `,
      "/ui/useToast": `
        export const useToast = () => ({ toast: (props) => globalThis.__gpuToasts.push(props) });
      `,
      "/utils/windowContext": `export const isControlPanelWindow = () => ${controlPanel};`,
    },
  });
  const { default: Listener } = await vite.ssrLoadModule(
    "/components/GpuPackMigrationToastListener.tsx"
  );
  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(Listener)));
  return calls;
}

test("the control panel takes the notice on mount and offers Settings", async (t) => {
  const calls = await mountListener(t, { controlPanel: true });

  assert.equal(globalThis.__gpuToasts.length, 1);
  const [toast] = globalThis.__gpuToasts;
  assert.match(toast.description, /CUDA whisper/);
  assert.equal(calls.shownDictationPanel, 0, "the control panel never surfaces the pill");
  assert.equal(calls.notifyReady, null, "the control panel doesn't wait to be told");

  assert.equal(toast.duration, 15000);
  toast.actions[0].onClick();
  assert.equal(calls.openedSection, "speechToText");
});

test("a notice naming only the llama pack opens AI Models settings", async (t) => {
  const calls = await mountListener(t, { controlPanel: true, notice: { packs: ["Vulkan llama"] } });

  globalThis.__gpuToasts[0].actions[0].onClick();
  assert.equal(calls.openedSection, "llms");
});

test("a notice naming whisper and llama packs opens Speech-to-Text settings", async (t) => {
  const calls = await mountListener(t, {
    controlPanel: true,
    notice: { packs: ["CUDA whisper", "Vulkan llama"] },
  });

  globalThis.__gpuToasts[0].actions[0].onClick();
  assert.equal(calls.openedSection, "speechToText");
});

test("the dictation panel takes the notice only when main says so, then surfaces", async (t) => {
  const calls = await mountListener(t, { controlPanel: false });

  assert.equal(calls.takes, 0, "nothing is taken before main says the normal app is up");
  assert.equal(globalThis.__gpuToasts.length, 0);

  await React.act(async () => calls.notifyReady());

  assert.equal(calls.takes, 1);
  assert.equal(calls.shownDictationPanel, 1, "a hidden pill is shown so the toast is seen");
  assert.equal(globalThis.__gpuToasts.length, 1);
  assert.equal(
    globalThis.__gpuToasts[0].duration,
    0,
    "kept until dismissed: a login may be unattended"
  );
});

test("a notice another window already took shows nothing", async (t) => {
  const calls = await mountListener(t, { controlPanel: false, notice: null });

  await React.act(async () => calls.notifyReady());

  assert.equal(calls.takes, 1);
  assert.equal(calls.shownDictationPanel, 0);
  assert.equal(globalThis.__gpuToasts.length, 0);
});
