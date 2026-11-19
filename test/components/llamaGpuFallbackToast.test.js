const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const en = require("../../src/locales/en/translation.json");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

test("a reasoning GPU fallback announces the CPU switch in the app window", async (t) => {
  let listener;
  let disposed = false;
  const toasts = [];
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        onLlamaGpuFallback(callback) {
          listener = callback;
          return () => {
            disposed = true;
          };
        },
      },
    },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-llama-gpu-toast-",
  });
  const { useLlamaGpuFallbackToast } = await vite.ssrLoadModule(
    "/hooks/useLlamaGpuFallbackToast.ts"
  );
  const root = createRoot(installHookDom(t));
  const tKey = (key) => key.split(".").reduce((value, segment) => value?.[segment], en);
  const toast = (notice) => toasts.push(notice);
  function Harness() {
    useLlamaGpuFallbackToast(toast, tKey);
    return null;
  }

  await React.act(async () => root.render(React.createElement(Harness)));
  listener({ reason: "out_of_memory" });
  assert.deepEqual(toasts[0], {
    title: en.gpu.activationFailed,
    description: en.gpu.reasoningOutOfMemoryDescription,
    variant: "destructive",
    duration: 10000,
    onSettled: toasts[0].onSettled,
  });
  listener({ reason: "out_of_memory" });
  assert.equal(toasts.length, 1, "the same fallback does not stack while its toast is visible");
  listener({ reason: "startup_failed" });
  assert.equal(toasts[1].description, en.gpu.reasoningActivationFailedDescription);
  toasts[0].onSettled();
  listener({ reason: "out_of_memory" });
  assert.equal(toasts.length, 3, "a later fallback can be announced again");
  await React.act(async () => root.unmount());
  assert.equal(disposed, true);
});
