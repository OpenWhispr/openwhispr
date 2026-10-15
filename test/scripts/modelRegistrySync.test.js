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

test("runtime fixes retain the signed contracts and record separate reviewed-source provenance", async () => {
  const { createVendoredFiles } = await import("../../scripts/sync-model-registry.mjs");
  const runtimeContracts = {
    ...contracts,
    schema: "reviewed schema fix\n",
    selection: "reviewed selection fix\n",
  };
  const runtimeContract = {
    sourceCommit: "c".repeat(40),
    contractHashes: Object.fromEntries(
      Object.entries(runtimeContracts).map(([key, value]) => [
        key,
        createHash("sha256").update(value).digest("hex"),
      ])
    ),
  };
  const options = {
    bytes,
    contracts,
    revision: "a".repeat(40),
    trustedKeys,
    runtimeContract,
    runtimeContracts,
  };
  const files = createVendoredFiles(options);
  const metadata = JSON.parse(files["registryMetadata.json"]);
  assert.equal(files["registryPublished/registrySchema.cjs"], contracts.schema);
  assert.equal(files["registrySchema.cjs"], runtimeContracts.schema);
  assert.deepEqual(metadata.contractHashes, manifest.contractHashes);
  assert.deepEqual(metadata.runtimeContract, runtimeContract);
  assert.equal(metadata.sourceCommit, manifest.sourceCommit);
  assert.deepEqual(createVendoredFiles(options), files);
  for (const [change, message] of [
    [
      { contracts: { ...contracts, schema: "tampered signed contract" } },
      /Contract digest mismatch/,
    ],
    [
      { runtimeContracts: { ...runtimeContracts, schema: "tampered runtime contract" } },
      /Runtime contract digest mismatch/,
    ],
    [{ runtimeContract: { ...runtimeContract, sourceCommit: "main" } }, /exact/],
    [{ runtimeContract: { ...runtimeContract, contractHashes: {} } }, /provenance/],
    [{ runtimeContracts: undefined }, /exact/],
    [{ runtimeContract: undefined }, /exact/],
  ])
    assert.throws(() => createVendoredFiles({ ...options, ...change }), message);
  // An ordinary sync deliberately returns to the publication's signed contracts.
  const reset = createVendoredFiles({ bytes, contracts, revision: "a".repeat(40), trustedKeys });
  assert.equal(reset["registrySchema.cjs"], contracts.schema);
  assert.equal(JSON.parse(reset["registryMetadata.json"]).runtimeContract, undefined);
});

test("offline verification detects edits to either contract copy and invalid runtime pins", (t) => {
  const fs = require("node:fs");
  const path = require("node:path");
  const os = require("node:os");
  const { spawnSync } = require("node:child_process");
  const root = path.resolve(__dirname, "../..");
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "registry-provenance-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  fs.mkdirSync(path.join(temporary, "scripts"), { recursive: true });
  fs.cpSync(
    path.join(root, "scripts/sync-model-registry.mjs"),
    path.join(temporary, "scripts/sync-model-registry.mjs")
  );
  fs.cpSync(path.join(root, "src/models"), path.join(temporary, "src/models"), { recursive: true });
  fs.symlinkSync(
    path.join(root, "node_modules"),
    path.join(temporary, "node_modules"),
    process.platform === "win32" ? "junction" : "dir"
  );
  const metadataFile = path.join(temporary, "src/models/registryMetadata.json");
  const fixtureMetadata = JSON.parse(fs.readFileSync(metadataFile, "utf8"));
  if (!fixtureMetadata.runtimeContract) {
    fixtureMetadata.runtimeContract = {
      sourceCommit: fixtureMetadata.sourceCommit,
      contractHashes: fixtureMetadata.contractHashes,
    };
    fs.writeFileSync(metadataFile, JSON.stringify(fixtureMetadata, null, 2) + "\n");
  }
  const run = () =>
    spawnSync(process.execPath, ["scripts/sync-model-registry.mjs", "--check"], {
      cwd: temporary,
      encoding: "utf8",
    });
  const initial = run();
  assert.equal(initial.status, 0, initial.stderr);
  for (const [relative, mutate, expected] of [
    [
      "src/models/registryPublished/registrySchema.cjs",
      (bytes) => bytes + "\n// changed\n",
      /Contract digest mismatch/,
    ],
    [
      "src/models/registrySchema.cjs",
      (bytes) => bytes + "\n// changed\n",
      /Runtime contract digest mismatch/,
    ],
    [
      "src/models/registryMetadata.json",
      (bytes) => {
        const metadata = JSON.parse(bytes);
        metadata.runtimeContract.sourceCommit = "main";
        return JSON.stringify(metadata);
      },
      /exact source commit/,
    ],
  ]) {
    const file = path.join(temporary, relative);
    const original = fs.readFileSync(file, "utf8");
    fs.writeFileSync(file, mutate(original));
    const result = run();
    assert.notEqual(result.status, 0, relative);
    assert.match(result.stderr, expected);
    fs.writeFileSync(file, original);
  }
});
