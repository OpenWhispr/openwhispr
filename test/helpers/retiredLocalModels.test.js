const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const seed = require("../../src/models/modelRegistryData.json");

const data = structuredClone(seed);
const provider = data.localProviders.find((item) => item.id === "qwen");
const [gguf, keptGguf] = provider.models;
Object.assign(gguf, { retired: true });
Object.assign(data.whisperModels.tiny, { retired: true });
Object.assign(data.parakeetModels["parakeet-tdt-110m-en"], { retired: true });
// A retired entry sharing its file with an offered one.
Object.assign(data.whisperModels.small, {
  retired: true,
  fileName: data.whisperModels.base.fileName,
});

test("only retired files go, and never one an offered model still uses", async (t) => {
  const store = await import("../../src/models/registryData.js");
  store.replaceRegistryData({ data, manifestVersion: store.getRegistryVersion() + 1 });
  const {
    configureInstalledModels,
    withInstalledModels,
  } = require("../../src/helpers/installedModels");
  const {
    listRetiredLocalModels,
    deleteRetiredLocalModels,
  } = require("../../src/helpers/retiredLocalModels");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "retired-models-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dirs = {
    whisperDir: path.join(root, "whisper"),
    parakeetDir: path.join(root, "parakeet"),
    llamaDir: path.join(root, "llama"),
  };
  Object.values(dirs).forEach((dir) => fs.mkdirSync(dir));
  const retiredGguf = path.join(dirs.llamaDir, gguf.fileName);
  const offeredGguf = path.join(dirs.llamaDir, keptGguf.fileName);
  const retiredWhisper = path.join(dirs.whisperDir, seed.whisperModels.tiny.fileName);
  const sharedWhisper = path.join(dirs.whisperDir, data.whisperModels.base.fileName);
  const retiredParakeet = path.join(dirs.parakeetDir, "parakeet-tdt-110m-en");
  const offeredParakeet = path.join(dirs.parakeetDir, "parakeet-tdt-0.6b-v3");
  for (const file of [retiredGguf, offeredGguf, retiredWhisper, sharedWhisper])
    fs.writeFileSync(file, "x");
  for (const dir of [retiredParakeet, offeredParakeet]) {
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "tokens.txt"), "x");
  }
  configureInstalledModels(path.join(root, "installed.json"));
  fs.writeFileSync(
    path.join(root, "installed.json"),
    JSON.stringify({ [JSON.stringify(["whisperModels", "", "tiny"])]: seed.whisperModels.tiny })
  );

  assert.deepEqual(
    listRetiredLocalModels(dirs)
      .map(({ id }) => id)
      .sort(),
    [gguf.id, "parakeet-tdt-110m-en", "tiny"].sort()
  );
  // A retired file still selected keeps running, so it isn't a leftover.
  const inUse = ["parakeet-tdt-110m-en"];
  assert.deepEqual(
    listRetiredLocalModels(dirs, inUse)
      .map(({ id }) => id)
      .sort(),
    [gguf.id, "tiny"].sort()
  );
  assert.deepEqual(deleteRetiredLocalModels(dirs, inUse), { success: true });
  assert.equal(fs.existsSync(retiredParakeet), true, "the selected one stays");
  assert.deepEqual(deleteRetiredLocalModels(dirs), { success: true });

  for (const gone of [retiredGguf, retiredWhisper, retiredParakeet])
    assert.equal(fs.existsSync(gone), false, gone);
  for (const kept of [offeredGguf, sharedWhisper, offeredParakeet])
    assert.equal(fs.existsSync(kept), true, kept);
  assert.deepEqual(listRetiredLocalModels(dirs), []);
  const merged = withInstalledModels({ ...seed, whisperModels: {} }, "99.0.0");
  assert.equal(Object.hasOwn(merged.whisperModels, "tiny"), false, "the record is forgotten too");
});
