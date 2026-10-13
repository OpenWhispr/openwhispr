const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

async function loadModules(t) {
  const { window } = installBrowserGlobals(t);
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-tone-style-test-" });
  return {
    window,
    prompts: await vite.ssrLoadModule("/config/prompts.ts"),
    toneStyle: await vite.ssrLoadModule("/config/toneStyle.ts"),
    openwhispr: (await vite.ssrLoadModule("/services/ai/inferenceProviders/openwhispr.ts"))
      .openwhisprProvider,
  };
}

test("the cleanup prompt ends with the app's medium, the tone and its priority", async (t) => {
  const { prompts } = await loadModules(t);
  const base = prompts.getCleanupSystemPrompt(null, ["OpenWhispr"], "en", "en");

  assert.equal(prompts.getCleanupSystemPrompt(null, ["OpenWhispr"], "en", "en", null), base);

  const email = prompts.getCleanupSystemPrompt(null, ["OpenWhispr"], "en", "en", {
    appCategory: "email",
    tone: "excited",
  });
  assert.ok(email.startsWith(base), "the tone comes after the dictionary suffix");
  const suffix = email.slice(base.length);
  assert.match(suffix, /^\n\nThe text is an email\. /);
  assert.match(suffix, /Apply this tone: upbeat and enthusiastic\./);
  assert.match(suffix, /overrides any instruction to keep the speaker's formality/);

  const other = prompts.getCleanupSystemPrompt(null, [], "en", "en", {
    appCategory: "other",
    tone: "formal",
  });
  assert.match(other, /\n\nApply this tone: formal and polished\./);
  assert.doesNotMatch(other, /The text is/);
});

test("Cloud cleanup sends the tone and category only for a toned dictation", async (t) => {
  const { window, openwhispr } = await loadModules(t);
  const requests = [];
  window.electronAPI.cloudReason = async (_text, options) => {
    requests.push(options);
    return { success: true, text: "ok" };
  };
  const ctx = {
    getCustomDictionary: () => [],
    getPreferredLanguage: () => "en",
    getUiLanguage: () => "en",
  };
  const call = (config) =>
    openwhispr.call({ text: "hey", model: "", agentName: null, config, ctx });

  await call({
    inferenceScope: "dictationCleanup",
    toneStyle: { appCategory: "personal", tone: "very_casual" },
  });
  await call({ inferenceScope: "dictationCleanup" });

  assert.equal(requests[0].tone, "very_casual");
  assert.equal(requests[0].appCategory, "personal");
  assert.equal(requests[0].promptMode, "cleanup");
  assert.equal("tone" in requests[1], false);
  assert.equal("appCategory" in requests[1], false);
});

test("stored tones keep only the options each category offers", async (t) => {
  const { toneStyle } = await loadModules(t);
  const { normalizeToneStyles, DEFAULT_TONE_STYLES } = toneStyle;

  assert.deepEqual(normalizeToneStyles(""), DEFAULT_TONE_STYLES);
  assert.deepEqual(normalizeToneStyles("not json"), DEFAULT_TONE_STYLES);
  assert.deepEqual(
    normalizeToneStyles(
      JSON.stringify({ personal: "very_casual", work: "very_casual", email: "excited" })
    ),
    { ...DEFAULT_TONE_STYLES, personal: "very_casual", email: "excited" }
  );
});
