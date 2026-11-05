const test = require("node:test");
const assert = require("node:assert/strict");
const modelRegistryData = require("../../src/models/modelRegistryData.json");
const {
  GENIEX_MODEL_PREFIX,
  buildPullArgs,
  buildServeArgs,
  geniexRefForFile,
  getGeniexCapability,
} = require("../../src/helpers/geniexServer");

test("serve args pin the NPU and carry the context window", () => {
  assert.deepEqual(buildServeArgs({ contextSize: 8192 }), [
    "--skip-update",
    "serve",
    "--compute",
    "npu",
    "--nctx",
    "8192",
  ]);
  // No context requested: the nctx flag is omitted rather than sent as 0.
  assert.deepEqual(buildServeArgs({ contextSize: null }), [
    "--skip-update",
    "serve",
    "--compute",
    "npu",
  ]);
});

test("pull args register a local GGUF file as an llm", () => {
  const args = buildPullArgs("openwhispr/Qwen3-0.6B-Q4_0", "C:\\models\\Qwen3-0.6B-Q4_0.gguf");
  assert.equal(args[0], "pull");
  assert.equal(args[1], "openwhispr/Qwen3-0.6B-Q4_0");
  assert.equal(args[2], "--local-path");
  assert.equal(args[3], "C:\\models\\Qwen3-0.6B-Q4_0.gguf");
  assert.equal(args[4], "--model-type");
  assert.equal(args[5], "llm");
});

test("geniex refs derive from the GGUF file name", () => {
  assert.equal(
    geniexRefForFile("Qwen3.5-2B-Q4_0.gguf"),
    `${GENIEX_MODEL_PREFIX}/Qwen3.5-2B-Q4_0`
  );
});

test("geniex capability gates on Windows on Snapdragon only", () => {
  assert.equal(getGeniexCapability({ platform: "win32", arch: "arm64" }).supported, true);
  assert.equal(getGeniexCapability({ platform: "win32", arch: "x64" }).supported, false);
  assert.equal(getGeniexCapability({ platform: "darwin", arch: "arm64" }).supported, false);
});

test("the qualcomm registry provider is NPU-only and download-ready", () => {
  const provider = modelRegistryData.localProviders.find((p) => p.id === "qualcomm");
  assert.ok(provider, "qualcomm provider missing from localProviders");
  assert.ok(provider.models.length > 0);

  const fileNames = new Set();
  const ids = new Set();
  for (const model of provider.models) {
    assert.equal(model.runtime, "geniex", `${model.id} must route to GenieX`);
    assert.equal(model.quantization, "q4_0", `${model.id} must be Q4_0 to land on the NPU`);
    assert.ok(model.hfRepo, `${model.id} needs an hfRepo for the download flow`);
    assert.ok(model.fileName.endsWith(".gguf"), `${model.id} must be a GGUF`);
    assert.ok(model.sizeBytes > 1_000_000, `${model.id} needs a real size`);
    assert.ok(model.contextLength > 0, `${model.id} needs a context length`);
    fileNames.add(model.fileName);
    ids.add(model.id);
  }

  // Every file name and id must be unique across the whole local registry:
  // findModelById resolves by id and downloads land in one shared models dir.
  for (const other of modelRegistryData.localProviders) {
    for (const model of other.models) {
      if (other.id !== "qualcomm") {
        assert.ok(!ids.has(model.id), `duplicate model id across providers: ${model.id}`);
        assert.ok(!fileNames.has(model.fileName), `duplicate file name: ${model.fileName}`);
      }
    }
  }
});
