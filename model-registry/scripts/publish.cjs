const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { generateKeyPairSync } = require("node:crypto");
const { readCatalog } = require("../lib/catalog.cjs");
const { verifyEnvelope } = require("../lib/envelope.cjs");
const { SCHEMA_VERSION, validateManifest } = require("../lib/schema.cjs");
const { createPublication, assertSigningKey } = require("../lib/publication.cjs");
const { readPublicationDir } = require("../lib/publicationDir.cjs");
const { checkCompatibility, droppedClients } = require("../lib/compat.cjs");
const { rollbackCatalog } = require("../lib/rollback.cjs");
const pinned = require("../trusted-keys.json");

// A dry run does everything a publication does except use the real key and push: it signs
// with a key made for this run, verifies the result and commits it locally. Pull requests
// run it, so a change that would break publishing fails before it merges.
const dryRun = process.env.REGISTRY_DRY_RUN === "1";
const directory = process.env.PUBLICATION_DIR;
const branch = process.env.PUBLICATION_BRANCH || "model-registry-published";
if (!directory) throw new Error("Publication directory required");
if (dryRun && process.env.REGISTRY_SIGNING_KEY)
  throw new Error("A dry run must not be given the signing key");
if (!dryRun && !process.env.REGISTRY_SIGNING_KEY) throw new Error("Signing key required");
const keyId = "primary-2026-10";
if (!dryRun) assertSigningKey(process.env.REGISTRY_SIGNING_KEY, keyId, pinned);
const signer = dryRun
  ? generateKeyPairSync("ed25519", {
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    })
  : null;
// The dry-run key is trusted by this process only; it never reaches trusted-keys.json.
const trusted = dryRun ? { ...pinned, "dry-run": signer.publicKey } : pinned;
const rollbackTo = process.env.ROLLBACK_TO ? Number(process.env.ROLLBACK_TO) : null;
if (rollbackTo !== null && !(Number.isSafeInteger(rollbackTo) && rollbackTo > 0))
  throw new Error(`ROLLBACK_TO must be a published version number, not ${process.env.ROLLBACK_TO}`);
const git = (args, cwd = process.cwd()) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
// The registry shares its repository with the apps, so its source is the last commit
// that changed this folder: an app merge neither republishes the catalog nor makes a
// publication in progress stale.
const registryCommit = (ref) => git(["rev-list", "-1", ref, "--", "."]);
const sourceCommit = registryCommit("HEAD");
if (!/^[a-f0-9]{40}$/.test(sourceCommit))
  throw new Error("No commit has changed the registry; the checkout needs full history");
const latestMain = () => {
  if (dryRun) return sourceCommit;
  git(["fetch", "--quiet", "origin", "main"]);
  return registryCommit("FETCH_HEAD");
};
// A stale normal run defers to the newer one; a rollback must never report success
// without publishing, so it fails instead and can be run again.
const skipStale = (message) => {
  console.log(message);
  process.exit(rollbackTo ? 1 : 0);
};
if (sourceCommit !== latestMain())
  skipStale("Skipped stale source; the newer main workflow owns publication.");
const output = path.join(directory, `v${SCHEMA_VERSION}`);
const readEnvelope = (file) => verifyEnvelope(fs.readFileSync(file), trusted);
// Verified, and null only on a branch that has never published: a branch whose manifest
// was deleted or put back to an older one must not restart or repeat the numbering.
const previous = readPublicationDir(directory, trusted)?.manifest;
const restoredFile = rollbackTo && path.join(output, "history", `${rollbackTo}.json`);
if (restoredFile && !fs.existsSync(restoredFile))
  throw new Error(`Version ${rollbackTo} has no v${SCHEMA_VERSION} history to roll back to`);
const restored = restoredFile && validateManifest(readEnvelope(restoredFile));
if (restored && restored.manifestVersion !== rollbackTo)
  throw new Error(`history/${rollbackTo}.json holds version ${restored.manifestVersion}`);
const data = restored ? rollbackCatalog(restored.data, previous.data) : readCatalog();
const envelope = createPublication({
  data,
  previous,
  rollback: !!rollbackTo,
  force: dryRun,
  sourceCommit,
  headCommit: latestMain(),
  testedClientContracts: checkCompatibility(data),
  droppedClientContracts: droppedClients(),
  keyId: dryRun ? "dry-run" : keyId,
  privateKey: dryRun ? signer.privateKey : process.env.REGISTRY_SIGNING_KEY,
});
if (!envelope) {
  // Still proves the deploy key may push here, so it is not first tried on a real change.
  git(["push", "--dry-run", "origin", `HEAD:${branch}`], directory);
  console.log(
    `Nothing to publish: version ${previous.manifestVersion} already serves this catalog and its readers.`
  );
  process.exit(0);
}
const manifest = validateManifest(verifyEnvelope(JSON.stringify(envelope), trusted));
const version = manifest.manifestVersion;
const history = path.join(output, "history", `${version}.json`);
if (fs.existsSync(history)) throw new Error("Refusing to overwrite a published version");
fs.mkdirSync(path.dirname(history), { recursive: true });
const bytes = JSON.stringify(envelope) + "\n";
fs.writeFileSync(path.join(output, "manifest.json"), bytes);
fs.writeFileSync(history, bytes);
// These files let desktop vendor the exact validated reader without trusting a later
// mutable branch. Their digests are the manifest's signed contractHashes.
for (const file of ["schema.cjs", "envelope.cjs", "registrySelection.js"])
  fs.copyFileSync(path.join("lib", file), path.join(output, file));
fs.copyFileSync("trusted-keys.json", path.join(output, "trusted-keys.json"));
fs.writeFileSync(
  path.join(directory, "README.md"),
  `# Published model registry\n\nCurrent: \`v${SCHEMA_VERSION}/manifest.json\`, version ${version}, source [${sourceCommit}](https://github.com/OpenWhispr/openwhispr/commit/${sourceCommit})${rollbackTo ? `, rolled back to the data of version ${rollbackTo}` : ""}. \`manifest.json\` at the root is the retired v1 format, frozen at version 3. Generated by the protected main publication workflow.\n`
);
git(["add", `v${SCHEMA_VERSION}`, "README.md"], directory);
// The identity is given to this commit only. Written to the checkout's config, it would also
// reach every worktree that shares it, which is what a local dry run publishes from.
git(
  [
    "-c",
    "user.name=github-actions[bot]",
    "-c",
    "user.email=41898282+github-actions[bot]@users.noreply.github.com",
    "commit",
    "-m",
    rollbackTo
      ? `Publish catalog ${version}: roll back to version ${rollbackTo}`
      : `Publish catalog ${version} from ${sourceCommit}`,
  ],
  directory
);
if (dryRun) {
  console.log(`Dry run: signed, verified and committed catalog ${version} from ${sourceCommit}; nothing pushed.`);
  process.exit(0);
}
if (sourceCommit !== latestMain()) skipStale("Skipped stale source before push.");
git(["push", "origin", `HEAD:${branch}`], directory);
console.log(`Published verified catalog ${version} from ${sourceCommit}`);
