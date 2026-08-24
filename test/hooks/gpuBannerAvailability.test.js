const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

function installHookDom(t) {
  const originalDocument = globalThis.document;
  const originalActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT;
  const noop = () => {};

  class Element {}
  class HTMLElement extends Element {}
  class HTMLIFrameElement extends HTMLElement {}

  const document = {
    nodeType: 9,
    activeElement: null,
    addEventListener: noop,
    removeEventListener: noop,
  };
  const container = {
    nodeType: 1,
    nodeName: "DIV",
    tagName: "DIV",
    namespaceURI: "http://www.w3.org/1999/xhtml",
    ownerDocument: document,
    addEventListener: noop,
    removeEventListener: noop,
    appendChild: noop,
    removeChild: noop,
    insertBefore: noop,
  };
  Object.assign(globalThis.window, {
    Element,
    HTMLElement,
    HTMLIFrameElement,
    document,
    getSelection: () => null,
  });
  document.defaultView = globalThis.window;
  document.documentElement = container;
  globalThis.document = document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;

  t.after(() => {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    if (originalActEnvironment === undefined) delete globalThis.IS_REACT_ACT_ENVIRONMENT;
    else globalThis.IS_REACT_ACT_ENVIRONMENT = originalActEnvironment;
  });

  return container;
}

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
