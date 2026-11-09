const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");

function loadManager() {
  const file = path.resolve(__dirname, "../../src/helpers/modelManagerBridge.js");
  const realRequire = createRequire(file);
  const module = { exports: {} };
  vm.runInNewContext(
    fs.readFileSync(file, "utf8"),
    {
      require(name) {
        if (name === "electron") return { app: { isReady: () => false } };
        if (name === "./downloadUtils") return {};
        if (name === "./llamaServer") return class {};
        if (name === "./debugLogger") return { debug() {}, info() {} };
        return realRequire(name);
      },
      module,
      process,
      console,
      Buffer,
    },
    { filename: file }
  );
  return module.exports.default;
}

test("GGUF main and draft downloads use their independently pinned commits", () => {
  const manager = loadManager();
  const model = {
    hfRepo: "org/model",
    fileName: "weights.gguf",
    revision: "a".repeat(40),
    draftHfRepo: "org/draft",
    draftFileName: "draft.gguf",
    draftRevision: "b".repeat(40),
  };
  const provider = { baseUrl: "https://huggingface.co" };
  assert.equal(
    manager.getDownloadUrl(provider, model),
    `https://huggingface.co/org/model/resolve/${model.revision}/weights.gguf`
  );
  assert.equal(
    manager.getDraftDownloadUrl(provider, model),
    `https://huggingface.co/org/draft/resolve/${model.draftRevision}/draft.gguf`
  );
  delete model.revision;
  delete model.draftRevision;
  assert.equal(
    manager.getDownloadUrl(provider, model),
    "https://huggingface.co/org/model/resolve/main/weights.gguf"
  );
  assert.equal(
    manager.getDraftDownloadUrl(provider, model),
    "https://huggingface.co/org/draft/resolve/main/draft.gguf"
  );
});

test("renderer local model URLs use the same immutable revision as downloads", () => {
  const { modelRegistry } = require("../../src/models/ModelRegistry.ts");
  const provider = modelRegistry.getAllProviders()[0];
  const model = { ...provider.models[0], revision: "c".repeat(40) };
  assert.equal(
    provider.getDownloadUrl(model),
    `${provider.baseUrl}/${model.hfRepo}/resolve/${model.revision}/${model.fileName}`
  );
});
