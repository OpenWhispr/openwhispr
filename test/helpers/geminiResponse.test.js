const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const load = () => import("../../src/helpers/geminiResponse.js");

function makeResponse({ parts, finishReason, usage } = {}) {
  return {
    candidates: [{ content: { parts }, finishReason }],
    usageMetadata: usage,
  };
}

test("normal response: joins all visible text parts and trims", async () => {
  const { extractGeminiCandidateText } = await load();
  const { text, finishReason } = extractGeminiCandidateText(
    makeResponse({ parts: [{ text: "Cleaned " }, { text: "text. " }], finishReason: "STOP" })
  );
  assert.equal(text, "Cleaned text.");
  assert.equal(finishReason, "STOP");
});

test("thought parts are excluded from the visible text", async () => {
  const { extractGeminiCandidateText } = await load();
  const { text } = extractGeminiCandidateText(
    makeResponse({
      parts: [{ text: "internal reasoning", thought: true }, { text: "Cleaned text." }],
      finishReason: "STOP",
    })
  );
  assert.equal(text, "Cleaned text.");
});

test("empty candidate keeps the #938 empty guard reachable", async () => {
  const { extractGeminiCandidateText } = await load();
  assert.equal(extractGeminiCandidateText(makeResponse({ finishReason: "STOP" })).text, "");
  assert.equal(extractGeminiCandidateText({}).text, "");
  assert.equal(extractGeminiCandidateText({}).finishReason, "");
  assert.equal(extractGeminiCandidateText(undefined).text, "");
});

test("truncated candidate reports MAX_TOKENS alongside its partial text", async () => {
  const { extractGeminiCandidateText, isGeminiTokenLimitHit } = await load();
  const { text, finishReason, usage } = extractGeminiCandidateText(
    makeResponse({
      parts: [{ text: "Ya tengo una pestaña abierta y he hecho una prueba en" }],
      finishReason: "MAX_TOKENS",
      usage: { totalTokenCount: 2000, thoughtsTokenCount: 1894, candidatesTokenCount: 106 },
    })
  );
  assert.ok(text.length > 0);
  assert.ok(isGeminiTokenLimitHit(finishReason));
  assert.equal(usage.thoughtsTokenCount, 1894);
});

test("isGeminiTokenLimitHit flags only MAX_TOKENS", async () => {
  const { isGeminiTokenLimitHit } = await load();
  assert.ok(isGeminiTokenLimitHit("MAX_TOKENS"));
  assert.ok(!isGeminiTokenLimitHit("STOP"));
  assert.ok(!isGeminiTokenLimitHit(""));
  assert.ok(!isGeminiTokenLimitHit(undefined));
});

test("cleanup suppresses thinking on thinking-capable models", async () => {
  const { resolveGeminiThinkingConfig } = await load();
  assert.deepEqual(resolveGeminiThinkingConfig({}, { supportsThinking: true }), {
    thinkingLevel: "minimal",
    includeThoughts: false,
  });
});

test("cleanup honors the model's minimum thinking level", async () => {
  const { resolveGeminiThinkingConfig } = await load();
  assert.deepEqual(
    resolveGeminiThinkingConfig({}, { supportsThinking: true, minThinkingLevel: "low" }),
    { thinkingLevel: "low", includeThoughts: false }
  );
});

test("unknown minimum thinking level falls back to minimal", async () => {
  const { resolveGeminiThinkingConfig } = await load();
  assert.equal(
    resolveGeminiThinkingConfig({}, { supportsThinking: true, minThinkingLevel: "bogus" })
      .thinkingLevel,
    "minimal"
  );
});

test("agent prompts keep thinking unless the user disabled it", async () => {
  const { resolveGeminiThinkingConfig } = await load();
  const modelDef = { supportsThinking: true };
  assert.equal(resolveGeminiThinkingConfig({ systemPrompt: "agent" }, modelDef), undefined);
  assert.equal(
    resolveGeminiThinkingConfig({ systemPrompt: "agent", disableThinking: false }, modelDef),
    undefined
  );
  assert.deepEqual(
    resolveGeminiThinkingConfig({ systemPrompt: "agent", disableThinking: true }, modelDef),
    { thinkingLevel: "minimal", includeThoughts: false }
  );
});

test("models without thinking support never get a thinkingConfig", async () => {
  const { resolveGeminiThinkingConfig } = await load();
  assert.equal(resolveGeminiThinkingConfig({}, {}), undefined);
  assert.equal(resolveGeminiThinkingConfig({}, undefined), undefined);
  assert.equal(resolveGeminiThinkingConfig({ disableThinking: true }, {}), undefined);
});

test("registry marks the thinking-by-default Gemini 3 models", () => {
  const data = require("../../src/models/modelRegistryData.json");
  const gemini = data.cloudProviders.find((p) => p.id === "gemini");
  const byId = Object.fromEntries(gemini.models.map((m) => [m.id, m]));

  assert.equal(byId["gemini-3-flash-preview"].supportsThinking, true);
  assert.equal(byId["gemini-3.1-pro-preview"].supportsThinking, true);
  // Gemini 3 Pro rejects thinkingLevel "minimal"; its floor is "low".
  assert.equal(byId["gemini-3.1-pro-preview"].minThinkingLevel, "low");

  const validLevels = ["minimal", "low", "medium", "high"];
  for (const provider of data.cloudProviders) {
    for (const model of provider.models) {
      if (model.minThinkingLevel !== undefined) {
        assert.ok(
          validLevels.includes(model.minThinkingLevel),
          `${model.id} has invalid minThinkingLevel "${model.minThinkingLevel}"`
        );
      }
    }
  }
});

// gemini.ts is TypeScript, so node --test can't require it. Assert the wiring
// from source the way inferenceProviderIds.test.js parses PROVIDER_REGISTRY.
test("gemini provider fails truncated candidates instead of returning them", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "../../src/services/ai/inferenceProviders/gemini.ts"),
    "utf8"
  );
  assert.match(src, /extractGeminiCandidateText\(response\)/);
  assert.match(src, /GEMINI_EMPTY_RESPONSE/);
  const truncationGuard = src.match(
    /if \(isGeminiTokenLimitHit\(finishReason\)\) \{[\s\S]*?GEMINI_TRUNCATED_RESPONSE[\s\S]*?throw new Error/
  );
  assert.ok(truncationGuard, "truncated candidates must throw so the raw transcription survives");
  assert.match(src, /resolveGeminiThinkingConfig\(config, modelDef\)/);
});
