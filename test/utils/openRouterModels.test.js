const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/utils/openRouterModels.ts");

// Shaped like OpenRouter's /models entries.
const model = (id, { tools = true, image = true } = {}) => ({
  id,
  supported_parameters: tools ? ["temperature", "tools"] : ["temperature"],
  architecture: { input_modalities: image ? ["text", "image"] : ["text"] },
});

test("batch and free variants and the non-answering routers are never offered", async () => {
  const { offersOpenRouterModel } = await load();
  for (const id of [
    "anthropic/claude-haiku-5.5:batch",
    "nvidia/nemotron-3-ultra-550b-a55b:free",
    "openrouter/free",
    "openrouter/fusion",
    "openrouter/bodybuilder",
  ]) {
    assert.equal(offersOpenRouterModel(model(id)), false, id);
  }
  assert.equal(offersOpenRouterModel(model("anthropic/claude-haiku-5.5")), true);
  assert.equal(offersOpenRouterModel(model("openrouter/auto")), true);
});

test("a scope's needs leave out models that lack them", async () => {
  const { offersOpenRouterModel } = await load();
  const textOnly = model("mistralai/mistral-small-24b-instruct-2501", { tools: false, image: false });
  const noTools = model("google/gemini-3.1-flash-image", { tools: false });
  const noImage = model("z-ai/glm-5.3", { image: false });
  const both = model("anthropic/claude-haiku-5.5");

  // Cleanup, translation and notes only need text.
  for (const entry of [textOnly, noTools, noImage, both]) {
    assert.equal(offersOpenRouterModel(entry, []), true, entry.id);
  }
  // Chat and the voice assistant send tools.
  assert.deepEqual(
    [textOnly, noTools, noImage, both].filter((entry) => offersOpenRouterModel(entry, ["tools"])),
    [noImage, both]
  );
  // The vision override sends tools and a screenshot.
  assert.deepEqual(
    [textOnly, noTools, noImage, both].filter((entry) =>
      offersOpenRouterModel(entry, ["tools", "image"])
    ),
    [both]
  );
  // An entry that doesn't describe its support doesn't get the benefit of the doubt.
  assert.equal(offersOpenRouterModel({ id: "vendor/unknown" }, ["tools"]), false);
});
