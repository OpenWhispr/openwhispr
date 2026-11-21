const { z } = require("zod");
const {
  SCHEMA_VERSION,
  assertCompatibleCatalog,
  validateCatalog,
  validateManifest,
} = require("./schema.cjs");
const { signEnvelope, verifyEnvelope } = require("./envelope.cjs");
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const seed = require("../test/seed.json");

// The three files an app vendors as its catalog reader, in `dir`.
function readerHashes(dir = __dirname) {
  const hash = (file) =>
    createHash("sha256")
      .update(fs.readFileSync(path.join(dir, file)))
      .digest("hex");
  return {
    schema: hash("schema.cjs"),
    envelope: hash("envelope.cjs"),
    selection: hash("registrySelection.js"),
  };
}

// A reader the last publication was tested with must still be tested, unless it was
// deliberately retired in compat/dropped-clients.json. Otherwise a changed reader file
// would silently leave every released app unable to accept any later catalog.
function assertReadersKept(testedClientContracts, previous, dropped = []) {
  const missing = (previous?.testedClientContracts ?? []).filter(
    (contract) => !testedClientContracts.includes(contract) && !dropped.includes(contract)
  );
  if (missing.length)
    throw new Error(
      `Readers tested by the last publication are no longer tested: ${missing.join(", ")}. ` +
        "Vendor them under compat/clients, or list them in compat/dropped-clients.json."
    );
}

// A run whose catalog is already published never signs, so a wrong key would otherwise pass
// unnoticed until the first real change, possibly after the old publisher was retired.
function assertSigningKey(privateKey, keyId, trustedKeys) {
  try {
    verifyEnvelope(JSON.stringify(signEnvelope(Buffer.from("{}"), keyId, privateKey)), trustedKeys);
  } catch (error) {
    throw new Error(`The signing key is not the private half of the pinned key ${keyId}: ${error.message}`);
  }
}

// Version 1 publications (before the lifecycle schema) carried a different envelope;
// only their version, source and data matter when continuing the sequence.
const previousSchema = z.object({
  schemaVersion: z.union([z.literal(1), z.literal(SCHEMA_VERSION)]),
  manifestVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
  contractHashes: z.record(z.string(), z.string()).optional(),
  testedClientContracts: z.array(z.string()).optional(),
  data: z.record(z.string(), z.unknown()),
});
const readPreviousManifest = (input) => previousSchema.parse(input);

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// What apps receive is the catalog, the reader it was made with and the readers it was
// tested with. A commit that leaves all three as published (documentation, tests, a
// dependency update) is not a new version for every app to download.
function alreadyPublished({ data, previous, sourceCommit, testedClientContracts }) {
  if (previous?.schemaVersion !== SCHEMA_VERSION) return false;
  if (previous.sourceCommit === sourceCommit) return true;
  return (
    same(previous.contractHashes, readerHashes()) &&
    same(previous.testedClientContracts, testedClientContracts) &&
    same(previous.data, validateCatalog(data))
  );
}

function createPublication({
  data,
  previous,
  sourceCommit,
  headCommit,
  testedClientContracts,
  publishedAt = new Date().toISOString(),
  keyId,
  privateKey,
  rollback = false,
  // A dry run signs even what is already published, so a pull request that changes only
  // how publishing works still exercises it.
  force = false,
  droppedClientContracts = [],
}) {
  if (sourceCommit !== headCommit) throw new Error("Stale source: main has advanced");
  if (
    !rollback &&
    !force &&
    alreadyPublished({ data, previous, sourceCommit, testedClientContracts })
  )
    return null;
  assertCompatibleCatalog(data, seed, { floor: seed });
  if (previous) assertCompatibleCatalog(data, previous.data, { floor: seed });
  assertReadersKept(testedClientContracts, previous, droppedClientContracts);
  const manifest = validateManifest({
    schemaVersion: SCHEMA_VERSION,
    manifestVersion: (previous?.manifestVersion || 0) + 1,
    publishedAt,
    sourceCommit,
    contractHashes: readerHashes(),
    testedClientContracts,
    data: validateCatalog(data),
  });
  return signEnvelope(Buffer.from(JSON.stringify(manifest)), keyId, privateKey);
}
module.exports = { createPublication, readPreviousManifest, readerHashes, assertReadersKept, assertSigningKey };
