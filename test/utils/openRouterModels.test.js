const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/utils/openRouterModels.ts");

// Shaped like OpenRouter's /models entries.
const model = (id, { tools = true } = {}) => ({
  id,
  supported_parameters: tools ? ["temperature", "tools"] : ["temperature"],
});

test("only models on the scope's tested list are offered", async () => {
  const { offersOpenRouterModel, OPENROUTER_TEXT_MODELS, OPENROUTER_VISION_MODELS } = await load();
  // Batch and free variants, routers and untested models are on neither list.
  for (const id of [
    "anthropic/claude-haiku-5.5:batch",
    "nvidia/nemotron-3-ultra-550b-a55b:free",
    "openrouter/auto",
    "openrouter/fusion",
    "mistralai/mistral-small-24b-instruct-2501",
  ]) {
    assert.equal(offersOpenRouterModel(model(id)), false, id);
    assert.equal(offersOpenRouterModel(model(id), ["tools", "image"]), false, id);
  }
  // Cleanup, translation, notes and chat offer the text list; the vision override its own.
  for (const id of OPENROUTER_TEXT_MODELS) {
    assert.equal(offersOpenRouterModel(model(id), ["tools"]), true, id);
  }
  for (const id of OPENROUTER_VISION_MODELS) {
    assert.equal(offersOpenRouterModel(model(id), ["tools", "image"]), true, id);
  }
  // Gemini 3.6 Flash read the screenshot but wrote too short a note.
  assert.equal(offersOpenRouterModel(model("google/gemini-3.6-flash")), false);
  assert.equal(offersOpenRouterModel(model("google/gemini-3.6-flash"), ["tools", "image"]), true);
});

test("a scope that sends tools drops a listed model that no longer supports them", async () => {
  const { offersOpenRouterModel } = await load();
  const lostTools = model("openai/gpt-4.1", { tools: false });
  assert.equal(offersOpenRouterModel(lostTools), true);
  assert.equal(offersOpenRouterModel(lostTools, ["tools"]), false);
  // An entry that doesn't describe its support doesn't get the benefit of the doubt.
  assert.equal(offersOpenRouterModel({ id: "openai/gpt-4.1" }, ["tools"]), false);
});

test("the default model is on both lists", async () => {
  const { OPENROUTER_DEFAULT_MODEL, OPENROUTER_TEXT_MODELS, OPENROUTER_VISION_MODELS } =
    await load();
  assert.ok(OPENROUTER_TEXT_MODELS.includes(OPENROUTER_DEFAULT_MODEL));
  assert.ok(OPENROUTER_VISION_MODELS.includes(OPENROUTER_DEFAULT_MODEL));
});
