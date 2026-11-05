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

test("a bundled whisper-server already on the GPU takes back the offer once it starts (#2168)", async (t) => {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  let bundledGpu = false;
  let notifyStatusChanged = null;
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        async getCudaWhisperStatus() {
          return {
            downloaded: false,
            bundledGpu,
            gpuInfo: { hasNvidiaGpu: true, cudaSupported: true },
          };
        },
        onWhisperGpuStatusChanged(callback) {
          notifyStatusChanged = callback;
          return () => {
            notifyStatusChanged = null;
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

  const props = {
    settings: {
      useLocalWhisper: true,
      localTranscriptionProvider: "whisper",
      useCleanupModel: false,
      cleanupMode: "openwhispr",
      useDictationAgent: false,
      dictationAgentMode: "openwhispr",
    },
    agentAllowedByPolicy: true,
    dismissed: false,
    settingsOpen: false,
    platform: "linux",
  };
  let availability;
  function Harness() {
    availability = useGpuBannerAvailability(props);
    return null;
  }
  root = createRoot(container);
  await React.act(async () => {
    root.render(React.createElement(Harness));
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.equal(availability.transcription, true, "offered before the server is up");

  // The launch pre-warm comes up on the distro's CUDA build of whisper-server
  bundledGpu = true;
  await React.act(async () => {
    notifyStatusChanged();
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.equal(availability.transcription, false);
});
