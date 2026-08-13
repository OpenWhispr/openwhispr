const test = require("node:test");
const assert = require("node:assert/strict");

const { normalizeBedrockCatalog } = require("../../src/helpers/bedrockCatalog");

const arn = (modelId) => `arn:aws:bedrock:eu-west-2::foundation-model/${modelId}`;

const MODELS = [
  {
    modelId: "anthropic.claude-haiku-4-5-20251001-v1:0",
    modelName: "Claude Haiku 4.5",
    providerName: "Anthropic",
    outputModalities: ["TEXT"],
    inferenceTypesSupported: ["INFERENCE_PROFILE"],
    modelLifecycle: { status: "ACTIVE" },
  },
  {
    modelId: "openai.gpt-oss-120b-1:0",
    modelName: "GPT-OSS 120B",
    providerName: "OpenAI",
    outputModalities: ["TEXT"],
    inferenceTypesSupported: ["ON_DEMAND"],
    modelLifecycle: { status: "ACTIVE" },
  },
  {
    modelId: "amazon.nova-lite-v1:0",
    modelName: "Nova Lite",
    providerName: "Amazon",
    outputModalities: ["TEXT"],
    inferenceTypesSupported: ["ON_DEMAND", "INFERENCE_PROFILE"],
    modelLifecycle: { status: "ACTIVE" },
  },
  {
    modelId: "amazon.nova-lite-v1:0:24k",
    modelName: "Nova Lite 24K",
    providerName: "Amazon",
    outputModalities: ["TEXT"],
    inferenceTypesSupported: ["PROVISIONED"],
    modelLifecycle: { status: "ACTIVE" },
  },
  {
    modelId: "amazon.titan-image-generator-v1",
    modelName: "Titan Image Generator",
    providerName: "Amazon",
    outputModalities: ["IMAGE"],
    inferenceTypesSupported: ["ON_DEMAND"],
    modelLifecycle: { status: "ACTIVE" },
  },
  {
    modelId: "anthropic.claude-v2",
    modelName: "Claude 2",
    providerName: "Anthropic",
    outputModalities: ["TEXT"],
    inferenceTypesSupported: ["ON_DEMAND"],
    modelLifecycle: { status: "LEGACY" },
  },
];

const PROFILES = [
  {
    inferenceProfileId: "eu.anthropic.claude-haiku-4-5-20251001-v1:0",
    models: [{ modelArn: arn("anthropic.claude-haiku-4-5-20251001-v1:0") }],
  },
];

test("resolves profile-only models to the region's inference profile ID", () => {
  const models = normalizeBedrockCatalog(MODELS, PROFILES);
  const haiku = models.find((m) => m.label === "Claude Haiku 4.5");
  assert.equal(haiku.value, "eu.anthropic.claude-haiku-4-5-20251001-v1:0");
  assert.equal(haiku.vendor, "Anthropic");
});

test("keeps bare IDs for on-demand models", () => {
  const models = normalizeBedrockCatalog(MODELS, PROFILES);
  assert.ok(models.some((m) => m.value === "openai.gpt-oss-120b-1:0"));
  assert.ok(models.some((m) => m.value === "amazon.nova-lite-v1:0"));
});

test("drops provisioned-only variants, non-text, non-active, and unresolvable models", () => {
  const models = normalizeBedrockCatalog(MODELS, PROFILES);
  const values = models.map((m) => m.value);
  assert.ok(!values.some((v) => v.includes(":24k")));
  assert.ok(!values.some((v) => v.includes("titan-image")));
  assert.ok(!values.some((v) => v.includes("claude-v2")));

  const noProfile = normalizeBedrockCatalog(
    [{ ...MODELS[0], inferenceTypesSupported: ["INFERENCE_PROFILE"] }],
    []
  );
  assert.equal(noProfile.length, 0);
});

test("sorts by vendor then label and dedupes by value", () => {
  const models = normalizeBedrockCatalog([...MODELS, MODELS[1]], PROFILES);
  assert.equal(models.filter((m) => m.value === "openai.gpt-oss-120b-1:0").length, 1);
  const vendors = models.map((m) => m.vendor);
  assert.deepEqual(vendors, [...vendors].sort((a, b) => a.localeCompare(b)));
});
