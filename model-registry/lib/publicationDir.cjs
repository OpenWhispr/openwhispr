const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { verifyEnvelope } = require("./envelope.cjs");
const { SCHEMA_VERSION } = require("./schema.cjs");
const { readPreviousManifest } = require("./publication.cjs");

const git = (directory, args) => {
  try {
    return execFileSync("git", args, {
      cwd: directory,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
};

// A symlink could make one published file stand in for another.
function readRegularFile(file) {
  if (!fs.lstatSync(file).isFile()) throw new Error(`${file} is not a regular file`);
  return fs.readFileSync(file);
}

// The publication a checkout of the published branch holds, or null for a branch that has
// never published. The branch is writable by more than the publishing job, so nothing is
// taken from it on trust: the manifest must carry a pinned key's signature and be the
// newest entry of its own history, and a branch that once published must still say what.
// Otherwise a deleted or older manifest would restart or repeat the version numbers.
function readPublicationDir(directory, trustedKeys) {
  // Publishing only fast-forwards the branch. A merge would let path-limited history below
  // follow whichever parent still matches and never see a deleted version.
  const merge = git(directory, ["rev-list", "--merges", "-1", "HEAD"]);
  if (merge) throw new Error(`The published branch has a merge commit, ${merge}`);
  const folder = `v${SCHEMA_VERSION}`;
  const output = path.join(directory, folder);
  const file = path.join(output, "manifest.json");
  if (fs.existsSync(file)) {
    const bytes = readRegularFile(file);
    const manifest = readPreviousManifest(verifyEnvelope(bytes, trustedKeys));
    const history = path.join(output, "history");
    const versions = (fs.existsSync(history) ? fs.readdirSync(history) : [])
      .map((name) => /^([1-9]\d*)\.json$/.exec(name))
      .filter(Boolean)
      .map((match) => Number(match[1]));
    const newest = Math.max(0, ...versions);
    if (manifest.schemaVersion !== SCHEMA_VERSION)
      throw new Error(`${folder}/manifest.json is not a version ${SCHEMA_VERSION} publication`);
    if (newest !== manifest.manifestVersion)
      throw new Error(
        `${folder}/manifest.json is version ${manifest.manifestVersion}, but its history ends at ${newest}`
      );
    if (!bytes.equals(readRegularFile(path.join(history, `${newest}.json`))))
      throw new Error(`${folder}/manifest.json differs from ${folder}/history/${newest}.json`);
    // Versions are only ever added. With the newest ones deleted and the manifest put back,
    // an earlier version would pass every check above and its successor be published twice.
    const rewritten = git(directory, [
      "log",
      "-1",
      "--no-renames",
      "--diff-filter=DMT",
      "--format=%H",
      "--",
      `${folder}/history`,
    ]);
    if (rewritten)
      throw new Error(`${folder}/history lost or changed a published version in ${rewritten}`);
    return { manifest, bytes };
  }
  if (git(directory, ["log", "-1", "--format=%H", "--", `${folder}/manifest.json`]))
    throw new Error(`${folder}/manifest.json was removed from the published branch`);
  // The retired v1 manifest, whose version numbers the v2 sequence continues.
  const legacy = path.join(directory, "manifest.json");
  if (fs.existsSync(legacy)) {
    const bytes = fs.readFileSync(legacy);
    return { manifest: readPreviousManifest(verifyEnvelope(bytes, trustedKeys)), bytes };
  }
  if (git(directory, ["rev-parse", "--verify", "--quiet", "HEAD"]))
    throw new Error("The published branch has commits but no manifest");
  return null;
}

// `candidate` may replace `current` as what an address serves: it never goes back a
// version, and never serves different bytes under a version already served.
function assertSucceeds(candidate, current) {
  if (!candidate) throw new Error("There is no publication to serve");
  if (!current) return;
  const [next, served] = [candidate.manifest.manifestVersion, current.manifest.manifestVersion];
  if (next < served) throw new Error(`Version ${next} would replace the newer version ${served}`);
  if (next === served && !candidate.bytes.equals(current.bytes))
    throw new Error(`Two different publications are numbered ${next}`);
}

module.exports = { readPublicationDir, assertSucceeds };
