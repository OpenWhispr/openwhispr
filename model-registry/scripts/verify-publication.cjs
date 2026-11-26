const { execFileSync } = require("node:child_process");
const { readPublicationDir, assertSucceeds } = require("../lib/publicationDir.cjs");
const trusted = require("../trusted-keys.json");

// node scripts/verify-publication.cjs <candidate> [<current>]
// Run before a checkout of a published branch is pushed anywhere: `candidate` is the
// checkout about to be served, `current` the one it replaces. Both branches can be
// written by more than the publishing job, so neither is copied on trust.
const [candidateDir, currentDir] = process.argv.slice(2);
try {
  if (!candidateDir) throw new Error("Usage: verify-publication.cjs <candidate> [<current>]");
  const candidate = readPublicationDir(candidateDir, trusted);
  assertSucceeds(candidate, currentDir ? readPublicationDir(currentDir, trusted) : null);
  const { manifestVersion, sourceCommit } = candidate.manifest;
  // A publication is signed from a registry commit on main. One signed from anywhere else
  // (the old repository, after the move) holds changes main lacks; the next publication
  // from main would silently undo them, so it stops here until they are brought to main.
  // Main as it is now: a re-run of an older run may meet a publication made after it.
  // The full ref: a short name would take a tag called main over the branch.
  execFileSync("git", ["fetch", "--quiet", "origin", "refs/heads/main"], { stdio: ["ignore", "ignore", "pipe"] });
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", sourceCommit, "FETCH_HEAD"], { stdio: "ignore" });
  } catch {
    throw new Error(`Version ${manifestVersion} was signed from ${sourceCommit}, which is not on main`);
  }
  console.log(`Verified publication ${manifestVersion} from ${sourceCommit}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
