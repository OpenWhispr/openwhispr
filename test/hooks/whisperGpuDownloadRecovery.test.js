const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

async function mountGpuDownloadHook(t, { cachePrefix, window }) {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });

  installBrowserGlobals(t, { window });
  const container = installHookDom(t);
  const vite = await createRendererServer(t, { cachePrefix });
  const { useWhisperGpuDownload } = await vite.ssrLoadModule("/hooks/useWhisperGpuDownload.ts");

  let state;
  function Harness() {
    state = useWhisperGpuDownload(true);
    return null;
  }

  root = createRoot(container);
  await React.act(async () => {
    root.render(React.createElement(Harness));
    await Promise.resolve();
    await Promise.resolve();
  });
  return () => state;
}

for (const backend of ["cuda", "vulkan"]) {
  test(`rehydrates and settles a ${backend.toUpperCase()} download after the picker remounts`, async (t) => {
    const isCuda = backend === "cuda";
    let phase = "downloading";
    let progressListener = null;
    let poll = null;
    let clearedInterval = null;
    let progressDisposed = false;
    const activeStatus = () => ({
      downloaded: phase === "complete",
      downloading: phase === "downloading",
      ...(isCuda
        ? {
            path: phase === "complete" ? "C:\\gpu\\whisper.exe" : null,
            gpuInfo: { hasNvidiaGpu: true, cudaSupported: true },
          }
        : {
            vulkan: { available: true },
            hasNvidiaGpu: false,
          }),
    });

    const getState = await mountGpuDownloadHook(t, {
      cachePrefix: `openwhispr-${backend}-whisper-download-recovery-test-`,
      window: {
        setInterval(callback, delay) {
          assert.equal(delay, 1000);
          poll = callback;
          return 17;
        },
        clearInterval(id) {
          clearedInterval = id;
        },
        electronAPI: {
          async getCudaWhisperStatus() {
            return isCuda
              ? activeStatus()
              : {
                  downloaded: false,
                  downloading: false,
                  path: null,
                  gpuInfo: { hasNvidiaGpu: false, cudaSupported: false },
                };
          },
          async getVulkanWhisperStatus() {
            return isCuda
              ? {
                  downloaded: false,
                  downloading: false,
                  vulkan: { available: false },
                  hasNvidiaGpu: true,
                }
              : activeStatus();
          },
          [isCuda ? "onCudaDownloadProgress" : "onVulkanWhisperDownloadProgress"](callback) {
            progressListener = callback;
            return () => {
              progressDisposed = true;
            };
          },
        },
      },
    });

    assert.equal(getState().gpuBackend, backend);
    assert.equal(getState().gpuDownloading, true);
    assert.equal(getState().gpuDownloaded, false);
    assert.equal(typeof progressListener, "function");
    assert.equal(typeof poll, "function");

    await React.act(async () => {
      progressListener({
        downloadedBytes: 25,
        totalBytes: 100,
        percentage: 25,
      });
    });
    assert.equal(getState().gpuProgress.percentage, 25);

    phase = "complete";
    await React.act(async () => {
      await poll();
      await Promise.resolve();
    });

    assert.equal(getState().gpuDownloading, false);
    assert.equal(getState().gpuDownloaded, true);
    assert.equal(progressDisposed, true);
    assert.equal(clearedInterval, 17);
  });
}

test("a download started by the mounted picker is not polled as a recovered download", async (t) => {
  let intervalCount = 0;
  let progressSubscribed = false;
  const getState = await mountGpuDownloadHook(t, {
    cachePrefix: "openwhispr-whisper-gpu-local-download-test-",
    window: {
      setInterval() {
        intervalCount += 1;
        return 1;
      },
      clearInterval() {},
      electronAPI: {
        async getCudaWhisperStatus() {
          return {
            downloaded: false,
            downloading: false,
            path: null,
            gpuInfo: { hasNvidiaGpu: true, cudaSupported: true },
          };
        },
        async getVulkanWhisperStatus() {
          return {
            downloaded: false,
            downloading: false,
            vulkan: { available: false },
            hasNvidiaGpu: true,
          };
        },
        onCudaDownloadProgress() {
          progressSubscribed = true;
          return () => {};
        },
      },
    },
  });

  await React.act(async () => {
    getState().startGpuDownload();
  });

  assert.equal(getState().gpuDownloading, true);
  assert.equal(progressSubscribed, true);
  assert.equal(intervalCount, 0, "only downloads recovered from main should be polled");
});
