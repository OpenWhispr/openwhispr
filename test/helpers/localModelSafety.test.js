const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const seed = require("../../src/models/modelRegistryData.json");

test("archive entries with Windows-reserved names are refused, and names compare without case", () => {
  const { assertSafeModelArchiveEntry } = require("../../src/helpers/modelArchiveIntegrity");
  const file = (entryPath) => ({ path: entryPath, type: "File" });
  for (const bad of ["root/aux.onnx", "root/CON", "root/sub/lpt1.txt", "root/nul"])
    assert.throws(() => assertSafeModelArchiveEntry(file(bad), "root"), /Unsafe/, bad);
  assert.equal(assertSafeModelArchiveEntry(file("root/Encoder.ONNX"), "root"), "root/encoder.onnx");
  assert.equal(
    assertSafeModelArchiveEntry({ path: "root/sub/", type: "Directory" }, "root"),
    "root/sub"
  );
});

test("a Cohere model without English falls back to a language it supports", () => {
  const store = require("../../src/models/registryData.js");
  const { resolveModelLanguage } = require("../../src/helpers/parakeetModelInfo");
  const old = store.getRegistrySnapshot();
  const data = structuredClone(old.data);
  const [cohereId] = Object.keys(data.parakeetModels).filter(
    (id) => data.parakeetModels[id].modelType === "cohere-transcribe"
  );
  data.parakeetModels["cohere-de-only"] = {
    ...structuredClone(data.parakeetModels[cohereId]),
    supportedLanguages: ["de", "fr"],
  };
  store.replaceRegistryData({ data, manifestVersion: old.manifestVersion + 1 });
  try {
    assert.equal(resolveModelLanguage("cohere-de-only", "ja"), "de");
    assert.equal(resolveModelLanguage("cohere-de-only", "fr-CA"), "fr");
    assert.equal(resolveModelLanguage(cohereId, "xx"), "en");
  } finally {
    store.replaceRegistryData({ data: old.data, manifestVersion: old.manifestVersion + 2 });
  }
});

test("the installed record keeps out a model the running app is too old for", (t) => {
  const store = require("../../src/models/registryData.js");
  const installed = require("../../src/helpers/installedModels");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "installed-gate-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  installed.configureInstalledModels(path.join(dir, "installed-models.json"));
  t.after(() => installed.configureInstalledModels(null));
  const old = store.getRegistrySnapshot();
  const data = structuredClone(old.data);
  data.whisperModels["future-whisper"] = {
    ...structuredClone(data.whisperModels.base),
    fileName: "ggml-future.bin",
    minAppVersion: "99.0.0",
  };
  store.replaceRegistryData({ data, manifestVersion: old.manifestVersion + 1 });
  t.after(() =>
    store.replaceRegistryData({ data: old.data, manifestVersion: old.manifestVersion + 2 })
  );
  installed.rememberInstalledModel("whisperModels", "", "future-whisper");
  assert.equal(
    installed.withInstalledModels(structuredClone(seed), "1.12.0").whisperModels["future-whisper"],
    undefined
  );
  assert.ok(
    installed.withInstalledModels(structuredClone(seed), "99.0.0").whisperModels["future-whisper"]
  );
});
