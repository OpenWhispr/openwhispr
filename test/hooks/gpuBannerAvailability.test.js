const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

test("closing settings refreshes a stale transcription GPU offer", async (t) => {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  let cudaDownloaded = false;
  let cudaProbeCount = 0;
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        async getCudaWhisperStatus() {
          cudaProbeCount += 1;
          return {
            downloaded: cudaDownloaded,
            gpuInfo: { hasNvidiaGpu: true, cudaSupported: true },
          };
        },
      },
    },
  });
  const container = installHookDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-gpu-banner-availability-test-",
  });
  const { useGpuBannerAvailability } = await vite.ssrLoadModule(
    "/hooks/useGpuBannerAvailability.ts"
  );

  const settings = {
    useLocalWhisper: true,
    localTranscriptionProvider: "whisper",
    useCleanupModel: false,
    cleanupMode: "openwhispr",
    useDictationAgent: false,
    dictationAgentMode: "openwhispr",
  };
  let props = {
    settings,
    agentAllowedByPolicy: true,
    dismissed: false,
    settingsOpen: false,
    platform: "win32",
  };
  let availability;
  function Harness() {
    availability = useGpuBannerAvailability(props);
    return null;
  }

  root = createRoot(container);
  const render = async () => {
    await React.act(async () => {
      root.render(React.createElement(Harness));
      await Promise.resolve();
      await Promise.resolve();
    });
  };

  await render();
  assert.equal(cudaProbeCount, 1);
  assert.equal(availability.transcription, true);

  props = { ...props, settingsOpen: true };
  await render();
  cudaDownloaded = true;
  assert.equal(cudaProbeCount, 1, "opening settings should not perform a redundant probe");

  props = { ...props, settingsOpen: false };
  await render();
  assert.equal(cudaProbeCount, 2);
  assert.equal(availability.transcription, false);
});
