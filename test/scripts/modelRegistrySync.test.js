const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash, generateKeyPairSync } = require("node:crypto");
const { signEnvelope } = require("../../src/models/registryEnvelope.cjs");
const seed = require("../../src/models/modelRegistryData.json");
const keys = generateKeyPairSync("ed25519");
const trustedKeys = { fixture: keys.publicKey.export({ type: "spki", format: "pem" }) };
const contracts = {
  schema: "schema source\n",
  envelope: "envelope source\n",
  selection: "selection source\n",
};
const hashes = Object.fromEntries(
  Object.entries(contracts).map(([key, value]) => [
    key,
    createHash("sha256").update(value).digest("hex"),
  ])
);
const manifest = {
  schemaVersion: 1,
  manifestVersion: 10,
  publishedAt: "2026-10-14T12:00:00Z",
  sourceCommit: "b".repeat(40),
  contractHashes: hashes,
  data: seed,
};
const bytes = JSON.stringify(
  signEnvelope(Buffer.from(JSON.stringify(manifest)), "fixture", keys.privateKey)
);

test("an exact signed publication produces deterministic snapshot, contracts and provenance", async () => {
  const { createVendoredFiles } = await import("../../scripts/sync-model-registry.mjs");
  const options = { bytes, contracts, revision: "a".repeat(40), trustedKeys };
  const first = createVendoredFiles(options);
  assert.deepEqual(createVendoredFiles(options), first);
  assert.deepEqual(JSON.parse(first["modelRegistryData.json"]), seed);
  assert.equal(first["registrySchema.cjs"], contracts.schema);
  assert.equal(JSON.parse(first["registryMetadata.json"]).sourceCommit, manifest.sourceCommit);
  assert.equal(JSON.parse(first["registryMetadata.json"]).publicationCommit, "a".repeat(40));
});
test("vendoring rejects unsigned code changes and mutable revision names", async () => {
  const { createVendoredFiles } = await import("../../scripts/sync-model-registry.mjs");
  assert.throws(
    () =>
      createVendoredFiles({
        bytes,
        contracts: { ...contracts, schema: "changed" },
        revision: "a".repeat(40),
        trustedKeys,
      }),
    /digest/
  );
  assert.throws(
    () => createVendoredFiles({ bytes, contracts, revision: "published", trustedKeys }),
    /exact/
  );
});
