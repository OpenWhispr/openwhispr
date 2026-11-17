const { z } = require("zod");
const {
  SCHEMA_VERSION,
  assertCompatibleCatalog,
  validateCatalog,
  validateManifest,
} = require("./schema.cjs");
const { signEnvelope } = require("./envelope.cjs");
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

// Version 1 publications (before the lifecycle schema) carried a different envelope;
// only their version, source and data matter when continuing the sequence.
const previousSchema = z.object({
  schemaVersion: z.union([z.literal(1), z.literal(SCHEMA_VERSION)]),
  manifestVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
  testedClientContracts: z.array(z.string()).optional(),
  data: z.record(z.string(), z.unknown()),
});
const readPreviousManifest = (input) => previousSchema.parse(input);

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
  droppedClientContracts = [],
}) {
  if (sourceCommit !== headCommit) throw new Error("Stale source: main has advanced");
  if (
    !rollback &&
    previous?.sourceCommit === sourceCommit &&
    previous.schemaVersion === SCHEMA_VERSION
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
module.exports = { createPublication, readPreviousManifest, readerHashes, assertReadersKept };
