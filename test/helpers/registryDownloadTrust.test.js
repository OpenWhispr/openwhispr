const test = require("node:test");
const assert = require("node:assert/strict");
const seed = require("../../src/models/modelRegistryData.json");
const {
  withTrustedDownloads,
  TRUSTED_HF_PUBLISHERS,
} = require("../../src/helpers/registryDownloadTrust");

const SHA = "a".repeat(64);
const localProvider = (data) => data.localProviders.find((provider) => provider.id === "qwen");

test("every download this release ships passes unchanged", () => {
  const rejected = [];
  assert.deepEqual(
    withTrustedDownloads(seed, seed, (id) => rejected.push(id)),
    seed
  );
  assert.deepEqual(rejected, []);
});

test("a GGUF from an untrusted publisher keeps its shipped copy, or leaves", () => {
  const data = structuredClone(seed);
  const provider = localProvider(data);
  const original = structuredClone(provider.models[0]);
  provider.models[0].hfRepo = "evil-org/evil";
  provider.models[0].sha256 = SHA;
  provider.models.push({ ...original, id: "evil-new", hfRepo: "evil-org/evil", sha256: SHA });
  const rejected = [];
  const trusted = withTrustedDownloads(data, seed, (id) => rejected.push(id));
  assert.deepEqual(localProvider(trusted).models[0], original);
  assert.equal(
    localProvider(trusted).models.some((model) => model.id === "evil-new"),
    false
  );
  assert.deepEqual(rejected, [original.id, "evil-new"]);
});

test("speech downloads are held to the same publishers, across their URL fields", () => {
  const data = structuredClone(seed);
  data.whisperModels.base.downloadUrl = "https://huggingface.co/evil/whisper/resolve/main/x.bin";
  data.whisperModels.base.sha256 = SHA;
  data.parakeetModels["orukeet-v0.1.0"].manifestUrl =
    "https://huggingface.co/evil/orukeet/resolve/main/manifest.json";
  data.whisperModels["evil-new"] = { ...data.whisperModels.base };
  const trusted = withTrustedDownloads(data, seed);
  assert.deepEqual(trusted.whisperModels.base, seed.whisperModels.base);
  assert.deepEqual(trusted.parakeetModels["orukeet-v0.1.0"], seed.parakeetModels["orukeet-v0.1.0"]);
  assert.equal(Object.hasOwn(trusted.whisperModels, "evil-new"), false);
});

test("a new or moved download must name its hash", () => {
  const data = structuredClone(seed);
  const provider = localProvider(data);
  const original = structuredClone(provider.models[0]);
  provider.models[0].revision = "b".repeat(40);
  provider.models.push({ ...original, id: "new-no-hash" });
  provider.models.push({ ...original, id: "new-hashed", sha256: SHA, revision: "b".repeat(40) });
  const models = localProvider(withTrustedDownloads(data, seed)).models;
  assert.deepEqual(models[0], original, "moved without a hash");
  assert.deepEqual(
    models.map((model) => model.id).filter((id) => id.startsWith("new-")),
    ["new-hashed"]
  );
});

test("a shipped download moves or rehashes, never both, and keeps a shipped hash", () => {
  const shipped = structuredClone(seed);
  const pinned = localProvider(shipped).models[0];
  pinned.sha256 = SHA;
  const data = structuredClone(shipped);
  const [moved, rehashed, kept, dropped] = ["moved", "rehashed", "kept", "dropped"].map((id) => {
    const model = { ...structuredClone(pinned), id };
    localProvider(shipped).models.push(structuredClone(model));
    localProvider(data).models.push(model);
    return model;
  });
  // Another commit, with the hash of whatever an attacker put there.
  Object.assign(moved, { revision: "b".repeat(40), sha256: "c".repeat(64) });
  Object.assign(rehashed, { sha256: "d".repeat(64) });
  Object.assign(kept, { revision: "b".repeat(40) });
  delete dropped.sha256;
  const rejected = [];
  const models = localProvider(
    withTrustedDownloads(data, shipped, (id) => rejected.push(id))
  ).models;
  const byId = (id) => models.find((model) => model.id === id);
  assert.deepEqual(rejected, ["moved", "dropped"]);
  assert.equal(byId("moved").revision, undefined, "the shipped location stays");
  assert.equal(byId("dropped").sha256, SHA);
  assert.equal(byId("rehashed").sha256, "d".repeat(64), "the location is unchanged");
  assert.equal(byId("kept").revision, "b".repeat(40), "the same bytes, somewhere else");
});

test("a shipped download without a hash can't move", () => {
  const data = structuredClone(seed);
  Object.assign(data.whisperModels.tiny, {
    downloadUrl: data.whisperModels.tiny.downloadUrl.replace("/main/", `/${"b".repeat(40)}/`),
    sha256: SHA,
  });
  assert.deepEqual(withTrustedDownloads(data, seed).whisperModels.tiny, seed.whisperModels.tiny);
});

test("retired entries stay, so their retirement still applies", () => {
  const data = structuredClone(seed);
  const provider = localProvider(data);
  Object.assign(provider.models[0], { retired: true, hfRepo: "evil-org/gone" });
  assert.equal(localProvider(withTrustedDownloads(data, seed)).models[0].retired, true);
});

test("the list covers the registry's publishers in use", () => {
  for (const provider of seed.localProviders)
    for (const model of provider.models)
      assert.ok(TRUSTED_HF_PUBLISHERS.has(model.hfRepo.split("/")[0]), model.id);
});
