const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createElement } = React;
const { createRoot } = require("react-dom/client");
const { renderToStaticMarkup } = require("react-dom/server");
const {
  createRendererServer,
  installBrowserGlobals,
  installHostDom,
} = require("../lib/rendererTestHarness");

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
    "/components/settings/SystemAudioSourceSettings.tsx"
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

// Radix Select renders a hidden native <select> whose effect reads
// window.HTMLSelectElement, which the host DOM does not have. Only the labels
// matter here, so the stub renders whatever it is given.
const SELECT_STUB = `
  const Pass = ({ children }) => children ?? null;
  export const Select = Pass;
  export const SelectTrigger = Pass;
  export const SelectValue = Pass;
  export const SelectContent = Pass;
  export const SelectItem = Pass;
`;

// Chromium lists the Windows default output as deviceId "default", labelled
// "Default - <name>", and fires devicechange when the default moves.
function installPlaybackDevices(t, label) {
  const listeners = new Set();
  const mediaDevices = {
    enumerateDevices: async () => [{ kind: "audiooutput", deviceId: "default", label }],
    addEventListener: (type, listener) => type === "devicechange" && listeners.add(listener),
    removeEventListener: (type, listener) => listeners.delete(listener),
  };
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    value: { mediaDevices },
    configurable: true,
    writable: true,
  });
  t.after(() => {
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    else delete globalThis.navigator;
  });
  return {
    listeners,
    switchDefault: (nextLabel) => {
      label = nextLabel;
      return Promise.all([...listeners].map((listener) => listener()));
    },
  };
}

async function mountSection(t, defaultOutputLabel) {
  // Registered first so it runs before the globals below are torn down.
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  installBrowserGlobals(t);
  const container = installHostDom(t);
  const devices = installPlaybackDevices(t, defaultOutputLabel);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-system-audio-source-mount-test-",
    mockModules: { "/ui/select": SELECT_STUB },
  });
  await vite.ssrLoadModule("/i18n.ts");
  const { SystemAudioSourceSettings } = await vite.ssrLoadModule(
    "/components/settings/SystemAudioSourceSettings.tsx"
  );
  root = createRoot(container);
  await React.act(async () =>
    root.render(
      createElement(SystemAudioSourceSettings, {
        platform: "win32",
        systemAudioSource: "default-device",
        onSystemAudioSourceChange: () => {},
      })
    )
  );
  return {
    listeners: devices.listeners,
    text: () => container.textContent,
    switchDefault: (label) => React.act(() => devices.switchDefault(label)),
    unmount: async () => {
      const mounted = root;
      root = null;
      await React.act(async () => mounted.unmount());
    },
  };
}

test("the opt-in names the Windows default output and follows it", async (t) => {
  const section = await mountSection(t, "Default - Speakers (Sound Blaster Z)");

  assert.ok(
    section.text().includes("Default Playback Device Only — Speakers (Sound Blaster Z)"),
    section.text()
  );

  await section.switchDefault("Default - Headphones (HyperX Cloud II)");
  assert.ok(
    section.text().includes("Default Playback Device Only — Headphones (HyperX Cloud II)"),
    section.text()
  );
  assert.ok(!section.text().includes("Sound Blaster"), section.text());

  await section.unmount();
  assert.equal(section.listeners.size, 0, "stops listening once the section closes");
});

test("the opt-in drops the device name while Chromium withholds labels", async (t) => {
  const section = await mountSection(t, "");

  assert.ok(section.text().includes("Default Playback Device Only"), section.text());
  assert.ok(!section.text().includes("—"), section.text());
});
