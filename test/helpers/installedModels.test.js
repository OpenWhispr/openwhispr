const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const seed = require("../../src/models/modelRegistryData.json");

test("installed local models survive a catalog that lacks them, but retired ones stay out", (t) => {
  const store = require("../../src/models/registryData.js");
  const installed = require("../../src/helpers/installedModels");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "installed-models-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  installed.configureInstalledModels(path.join(dir, "installed-models.json"));
  t.after(() => installed.configureInstalledModels(null));

  const withRemote = structuredClone(seed);
  const provider = withRemote.localProviders[0];
  provider.models.push({ ...provider.models[0], id: "remote-gguf", fileName: "remote.gguf" });
  withRemote.whisperModels["remote-whisper"] = {
    ...withRemote.whisperModels.base,
    fileName: "ggml-remote.bin",
  };
  store.replaceRegistryData({ data: withRemote, manifestVersion: store.getRegistryVersion() + 1 });
  installed.rememberInstalledModel("localProviders", provider.id, "remote-gguf");
  installed.rememberInstalledModel("whisperModels", "", "remote-whisper");

  const restored = installed.withInstalledModels(structuredClone(seed));
  assert.ok(restored.localProviders[0].models.some((m) => m.id === "remote-gguf"));
  assert.equal(restored.whisperModels["remote-whisper"].fileName, "ggml-remote.bin");

  const retired = structuredClone(seed);
  retired.whisperModels["remote-whisper"] = {
    ...withRemote.whisperModels["remote-whisper"],
    retired: true,
  };
  assert.equal(
    installed.withInstalledModels(retired).whisperModels["remote-whisper"].retired,
    true
  );

  installed.forgetInstalledModels("whisperModels", "", "remote-whisper");
  installed.forgetInstalledModels("localProviders");
  const forgotten = installed.withInstalledModels(structuredClone(seed));
  assert.equal(forgotten.whisperModels["remote-whisper"], undefined);
  assert.equal(
    forgotten.localProviders[0].models.some((m) => m.id === "remote-gguf"),
    false
  );
});

test("a damaged record can't stop catalog updates or reach the prototype", (t) => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const seed = require("../../src/models/modelRegistryData.json");
  const {
    configureInstalledModels,
    withInstalledModels,
  } = require("../../src/helpers/installedModels");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "installed-damaged-"));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    configureInstalledModels(null);
  });
  const file = path.join(dir, "installed.json");
  configureInstalledModels(file);
  const key = (...parts) => JSON.stringify(parts);
  fs.writeFileSync(
    file,
    JSON.stringify({
      [key("whisperModels", "", "null-entry")]: null,
      [key("whisperModels", "", "text-entry")]: "x",
      [key("whisperModels", "qwen", "wrong-shape")]: { name: "x" },
      [key("localProviders", "", "no-provider")]: { name: "x" },
      [key("__proto__", "", "polluted")]: { name: "x" },
      [key("whisperModels", "", "__proto__")]: { polluted: true },
      "not json": { name: "x" },
      [key("whisperModels", "", "kept")]: {
        ...seed.whisperModels.base,
        name: "Kept",
        fileName: "ggml-kept.bin",
      },
      [key("whisperModels", "", "unsafe-name")]: {
        ...seed.whisperModels.base,
        fileName: "../../outside.bin",
      },
      [key("whisperModels", "", "incomplete")]: { name: "x" },
      [key("localProviders", "qwen", "unsafe-gguf")]: {
        ...seed.localProviders.find((p) => p.id === "qwen").models[0],
        fileName: "../escape.gguf",
      },
    })
  );
  const merged = withInstalledModels(seed, "99.0.0");
  assert.equal(merged.whisperModels.kept.name, "Kept");
  for (const id of ["null-entry", "text-entry", "wrong-shape", "unsafe-name", "incomplete"])
    assert.equal(Object.hasOwn(merged.whisperModels, id), false, id);
  assert.equal(
    merged.localProviders.find((p) => p.id === "qwen").models.some((m) => m.id === "unsafe-gguf"),
    false
  );
  assert.equal({}.polluted, undefined);
  assert.equal(merged.whisperModels.polluted, undefined);
});
