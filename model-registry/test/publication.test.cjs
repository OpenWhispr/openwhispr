const test = require("node:test");
const assert = require("node:assert/strict");
const { generateKeyPairSync } = require("node:crypto");
const {
  createPublication,
  readPreviousManifest,
  assertReadersKept,
} = require("../lib/publication.cjs");
const { verifyEnvelope } = require("../lib/envelope.cjs");
const { validateManifest } = require("../lib/schema.cjs");
const { readCatalog } = require("../lib/catalog.cjs");

const base = readCatalog();
const keys = generateKeyPairSync("ed25519");
const tested = ["c".repeat(64)];
const options = {
  data: base,
  sourceCommit: "a".repeat(40),
  headCommit: "a".repeat(40),
  testedClientContracts: tested,
  keyId: "test",
  privateKey: keys.privateKey,
  publishedAt: "2026-11-03T12:00:00Z",
};
const trusted = { test: keys.publicKey.export({ type: "spki", format: "pem" }) };
const open = (envelope) => validateManifest(verifyEnvelope(JSON.stringify(envelope), trusted));

test("v2 continues the v1 version sequence and signs the readers it was tested with", () => {
  const v1 = readPreviousManifest({
    schemaVersion: 1,
    manifestVersion: 3,
    sourceCommit: "f".repeat(40),
    contractHashes: {},
    data: base,
  });
  const manifest = open(createPublication({ ...options, previous: v1 }));
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.manifestVersion, 4);
  assert.deepEqual(manifest.testedClientContracts, tested);
  assert.match(manifest.contractHashes.schema, /^[a-f0-9]{64}$/);
});

test("reruns are idempotent; rollbacks and removals are handled explicitly", () => {
  const first = open(createPublication({ ...options }));
  assert.equal(createPublication({ ...options, previous: first }), null);
  assert.equal(open(createPublication({ ...options, previous: first, rollback: true })).manifestVersion, 2);
  const data = structuredClone(base);
  data.cloudProviders[0].models.push({ id: "new-published", name: "New", description: "Fixture" });
  const next = { ...options, sourceCommit: "b".repeat(40), headCommit: "b".repeat(40) };
  const second = open(createPublication({ ...next, data, previous: first }));
  assert.equal(second.manifestVersion, 2);
  assert.throws(
    () => createPublication({ ...next, sourceCommit: "c".repeat(40), headCommit: "c".repeat(40), previous: second }),
    /retire it instead/
  );
});

test("a stale queued source cannot publish after a newer main commit", () => {
  assert.throws(() => createPublication({ ...options, headCommit: "b".repeat(40) }), /Stale source/);
});

test("the app-facing manifest is tolerant at the top level but strict about trust fields", () => {
  const manifest = open(createPublication({ ...options }));
  assert.doesNotThrow(() => validateManifest({ ...manifest, futureField: true }));
  assert.throws(() => validateManifest({ ...manifest, schemaVersion: 1 }));
  assert.throws(() => validateManifest({ ...manifest, testedClientContracts: [] }));
});

test("a publication cannot silently stop testing a reader the last one tested", () => {
  const previous = { testedClientContracts: ["a".repeat(64), "b".repeat(64)] };
  assert.throws(() => assertReadersKept(["a".repeat(64)], previous), /no longer tested: b{64}/);
  assert.doesNotThrow(() => assertReadersKept(["a".repeat(64)], previous, ["b".repeat(64)]));
  assert.doesNotThrow(() => assertReadersKept(["c".repeat(64)], undefined));
  const first = open(createPublication({ ...options }));
  assert.throws(
    () =>
      createPublication({
        ...options,
        sourceCommit: "d".repeat(40),
        headCommit: "d".repeat(40),
        previous: first,
        testedClientContracts: ["e".repeat(64)],
      }),
    /no longer tested/
  );
});
