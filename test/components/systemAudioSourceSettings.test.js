const test = require("node:test");
const assert = require("node:assert/strict");
const { createElement } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// #1546: the System Audio section is a Windows-only choice. macOS records
// through its own audio tap and Linux through PipeWire, so neither may show it,
// not even as an empty header.
async function loadSection(t) {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-system-audio-source-section-test-",
  });
  await vite.ssrLoadModule("/i18n.ts");
  const { SystemAudioSourceSettings } = await vite.ssrLoadModule(
    "/components/ui/SystemAudioSourceSettings.tsx"
  );
  return (props) =>
    renderToStaticMarkup(
      createElement(SystemAudioSourceSettings, {
        systemAudioSource: "all-devices",
        onSystemAudioSourceChange: () => {},
        ...props,
      })
    );
}

test("macOS and Linux get no section at all", async (t) => {
  const render = await loadSection(t);

  assert.equal(render({ platform: "darwin" }), "");
  assert.equal(render({ platform: "linux" }), "");
});

test("Windows shows its own System Audio section with every device selected", async (t) => {
  const render = await loadSection(t);
  const markup = render({ platform: "win32" });

  assert.ok(markup.includes(">System Audio</h3>"), markup);
  assert.ok(markup.includes("Choose which speakers Note Recording listens to"), markup);
  assert.ok(markup.includes(">Playback Device</label>"), markup);
  assert.ok(markup.includes("All Playback Devices"), markup);
  assert.ok(markup.includes("Voicemod or VB-Cable"), "names the virtual-device risk");
});

test("the Playback Device label names the dropdown for screen readers", async (t) => {
  const render = await loadSection(t);
  const markup = render({ platform: "win32" });

  assert.ok(markup.includes('for="system-audio-source"'), markup);
  assert.ok(markup.includes('id="system-audio-source"'), markup);
});

test("the opt-in says plainly what it can miss", async (t) => {
  const render = await loadSection(t);
  const markup = render({ platform: "win32", systemAudioSource: "default-device" });

  assert.ok(markup.includes("Default Playback Device Only"), markup);
  assert.ok(markup.includes("won&#x27;t be captured"), markup);
});
