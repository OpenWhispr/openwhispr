const assert = require("node:assert/strict");
const test = require("node:test");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

test("useAudioRecording accepts an onboarding event handler on its initial render", async (t) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-audio-recording-initialization-",
    mockModules: {
      "/helpers/audioManager": "export default class AudioManager {}",
    },
  });
  const { useAudioRecording } = await vite.ssrLoadModule("/hooks/useAudioRecording.js");

  function InitialRenderProbe() {
    useAudioRecording(() => {}, { onDemoEvent: () => {} });
    return React.createElement("div");
  }

  assert.doesNotThrow(() => renderToStaticMarkup(React.createElement(InitialRenderProbe)));
});
