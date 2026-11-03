const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const modelData = require("../../src/models/modelRegistryData.json");
const localSetupTable = require("../../src/models/localSetupTable.json");

// Which local models get the assistant's tools is a mark in the model list, not a
// size read from the id: "-4b" gave tools to Gemma 3, which has no tool format and
// acts tools out in text, and "e2b" gave none to Gemma 4 E2B, which calls them well
// (Titan local-model exam, 2026-11-02).
const localModels = modelData.localProviders.flatMap((provider) => provider.models);
const byId = new Map(localModels.map((model) => [model.id, model]));

test("every Gemma 4 calls tools and can be asked not to think", () => {
  const gemma4 = localModels.filter((model) => model.id.startsWith("gemma-4-"));
  assert.ok(gemma4.length >= 4, "the Gemma 4 family is listed");
  for (const model of gemma4) {
    assert.equal(model.supportsTools, true, `${model.id} supportsTools`);
    assert.equal(model.supportsThinking, true, `${model.id} supportsThinking`);
  }
});

test("Gemma 3 never gets tools, whatever its size", () => {
  const gemma3 = localModels.filter((model) => model.id.startsWith("gemma-3-"));
  assert.ok(gemma3.some((model) => model.id === "gemma-3-4b-it-q4_k_m"));
  for (const model of gemma3) assert.equal(model.supportsTools, undefined, model.id);
});

test("the models the size rule gave tools keep them", () => {
  for (const id of ["qwen3.5-4b-q4_k_m", "qwen3.5-9b-q4_k_m", "gpt-oss-20b-mxfp4"]) {
    assert.equal(byId.get(id)?.supportsTools, true, id);
  }
  for (const id of ["qwen3.5-2b-q4_k_m", "qwen3.5-0.8b-q4_k_m", "lfm2.5-350m-q8_0"]) {
    assert.equal(byId.get(id)?.supportsTools, undefined, id);
  }
});

test("onboarding's assistant pick can use tools", () => {
  const pick = byId.get(localSetupTable.models.assistant);
  assert.ok(pick, localSetupTable.models.assistant);
  assert.equal(pick.supportsTools, true);
});

test("the chat reads the mark, not the model's name", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../../src/components/chat/useChatStreaming.ts"),
    "utf8"
  );
  assert.match(source, /getLocalModel\(llmConfig\.model\)\?\.supportsTools/);
  assert.doesNotMatch(source, /estimateModelSizeB|LOCAL_TOOL_MIN_PARAMS_B/);
});
