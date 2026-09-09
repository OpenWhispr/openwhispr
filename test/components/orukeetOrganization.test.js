const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const path = require("node:path");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const noop = () => {};
async function renderer(t) {
  installBrowserGlobals(t, {
    window: { location: { search: "" }, electronAPI: { getPlatform: () => "darwin" } },
  });
  return createRendererServer(t, {
    cachePrefix: "openwhispr-oruk-organization-",
    resolveAlias: { "@": path.resolve(__dirname, "../../src") },
    mockModules: {
      "react-i18next": `export function useTranslation() { return {t(key) {return key;}}; }`,
    },
  });
}

async function render(vite, element) {
  const { ToastProvider } = await vite.ssrLoadModule("/components/ui/Toast.tsx");
  return renderToStaticMarkup(React.createElement(ToastProvider, null, element));
}

test("fresh onboarding lists Orukeet under Oruk without mixing NVIDIA models", async (t) => {
  const vite = await renderer(t);
  const { LocalModelSetupStep } = await vite.ssrLoadModule(
    "/components/onboarding/ProviderSetupStep.tsx"
  );
  const markup = await render(
    vite,
    React.createElement(LocalModelSetupStep, {
      stepId: "local-dictation",
      onReadinessChange: noop,
      onProceed: noop,
      onSkip: noop,
    })
  );
  assert.match(markup, />Oruk</);
  assert.match(markup, />Orukeet</);
  assert.doesNotMatch(markup, />Parakeet TDT/);
});

test("all three model pickers restore the Oruk tab from the persisted Orukeet choice", async (t) => {
  const vite = await renderer(t);
  const { default: Picker } = await vite.ssrLoadModule("/components/TranscriptionModelPicker.tsx");
  for (const transcriptionContext of ["dictation", "upload", "meeting"]) {
    const markup = await render(
      vite,
      React.createElement(Picker, {
        transcriptionContext,
        selectedLocalProvider: "nvidia",
        selectedLocalModel: "orukeet-v0.1.0-q8",
        useLocalWhisper: true,
        onLocalModelSelect: noop,
        onModeChange: noop,
      })
    );
    assert.match(markup, />Orukeet</, transcriptionContext);
    assert.doesNotMatch(markup, />Parakeet TDT/, transcriptionContext);
  }
});

test("a saved stock Parakeet choice opens NVIDIA while retaining Oruk as a selectable organization", async (t) => {
  const vite = await renderer(t);
  const { default: Picker } = await vite.ssrLoadModule("/components/TranscriptionModelPicker.tsx");
  const markup = await render(
    vite,
    React.createElement(Picker, {
      selectedLocalProvider: "nvidia",
      selectedLocalModel: "parakeet-tdt-0.6b-v3",
      useLocalWhisper: true,
      onLocalModelSelect: noop,
      onModeChange: noop,
    })
  );
  assert.match(markup, />Oruk</);
  assert.match(markup, />Parakeet TDT/);
  assert.doesNotMatch(markup, />Orukeet</);
});
