const assert = require("node:assert/strict");
const test = require("node:test");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

// The onboarding session is plain-text localStorage, while every one of these is a
// safeStorage secret. Named literally so a leak shows up as the value, not just as
// an unexpected key.
const SECRETS = {
  openaiApiKey: "sk-leaked-openai-key",
  cortiClientId: "leaked-corti-client-id",
  cortiClientSecret: "leaked-corti-client-secret",
  customTranscriptionApiKey: "leaked-custom-transcription-key",
  chatAgentCustomApiKey: "leaked-chat-agent-key",
};

const ALLOWED_DRAFT_KEYS = ["baseUrl", "customModel", "selectedModel", "selectedProvider"];

async function collectByokDrafts(t, { stepId, selfHostedRequested, resumeState }) {
  installBrowserGlobals(t, {
    window: { electronAPI: { getPlatform: () => "linux" } },
  });
  const container = installHookDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-byok-resume-draft-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `
        const t = (key) => key;
        export function useTranslation() { return { t }; }
        export const initReactI18next = { type: "3rdParty", init() {} };
      `,
      "/ProviderConnectionTest": `export default function ProviderConnectionTest() { return null; }`,
      "/OnboardingShell": `export function BrandMark() { return null; }`,
      "/ui/ProviderIcon": `export function ProviderIcon() { return null; }`,
    },
  });
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  useSettingsStore.setState(SECRETS);
  const { ByokProviderStep } = await vite.ssrLoadModule(
    "/components/onboarding/ProviderSetupStep.tsx"
  );

  const drafts = [];
  function Harness() {
    // Execute the real component and hooks with React lifecycle, while leaving
    // native controls unmounted: the persisted draft is the test boundary.
    ByokProviderStep({
      stepId,
      selfHostedRequested,
      resumeState,
      onSelfHostedChange() {},
      onConnectionChange() {},
      onProceed() {},
      onResumeStateChange: (draft) => drafts.push(draft),
    });
    return null;
  }
  const root = createRoot(container);
  await React.act(async () => {
    root.render(React.createElement(Harness));
  });
  // The typed fields are debounced, and unmounting flushes the pending write — the
  // same path the step takes when onboarding advances past it.
  await React.act(async () => root.unmount());
  return drafts;
}

// Each case has to actually load a credential or the value assertions guard
// nothing: the step only seeds the one its step and mode select. A hosted step
// with no resumed provider opens on none, leaving every credential state empty.
for (const [name, options] of [
  [
    "a hosted provider",
    {
      stepId: "byok-dictation",
      selfHostedRequested: false,
      resumeState: { selectedProvider: "openai", selectedModel: "", baseUrl: "", customModel: "" },
    },
  ],
  ["a self-hosted transcription endpoint", { stepId: "byok-dictation", selfHostedRequested: true }],
  ["a self-hosted assistant endpoint", { stepId: "byok-assistant", selfHostedRequested: true }],
]) {
  test(`the resume draft for ${name} carries no credential`, async (t) => {
    const drafts = await collectByokDrafts(t, options);

    assert.ok(drafts.length > 0, "the step persists a draft so the session can restore it");
    for (const draft of drafts) {
      assert.deepEqual(
        Object.keys(draft).sort(),
        ALLOWED_DRAFT_KEYS,
        "a draft may only carry the four fields the session schema declares"
      );
      const serialized = JSON.stringify(draft);
      for (const [field, secret] of Object.entries(SECRETS)) {
        assert.doesNotMatch(serialized, new RegExp(secret), `${field} reached the draft`);
      }
    }
  });
}
