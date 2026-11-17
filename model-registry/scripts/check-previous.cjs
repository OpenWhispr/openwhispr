const fs = require("node:fs");
const { readCatalog, assertCompatibleCatalog, capabilityChanges } = require("../lib/catalog.cjs");
const { fetchPublished } = require("../lib/published.cjs");
const { assertReadersKept } = require("../lib/publication.cjs");
const { checkCompatibility, droppedClients } = require("../lib/compat.cjs");
const seed = require("../test/seed.json");

// Published request settings may change only with a maintainer's capability-change label.
// A push after the label was added invalidates it: the maintainer re-adds it once they
// have checked the new commits (removing and re-adding re-runs this check).
function pullRequestLabels() {
  if (!process.env.GITHUB_EVENT_PATH) return null;
  const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  if (!event.pull_request) return null;
  const labels = event.pull_request.labels.map((label) => label.name);
  return event.action === "synchronize"
    ? labels.filter((label) => label !== "capability-change")
    : labels;
}

(async () => {
  const previous = await fetchPublished();
  if (!previous) return console.log("No publication yet; the shipping floor still applies.");
  const catalog = readCatalog();
  assertCompatibleCatalog(catalog, previous.data, { floor: seed });
  assertReadersKept(checkCompatibility(catalog), previous, droppedClients());
  console.log(`Compatible with published version ${previous.manifestVersion}`);
  const changes = capabilityChanges(catalog, previous.data);
  for (const change of changes)
    console.log(`Request settings change: ${change.provider}/${change.id} (${change.fields.join(", ")})`);
  const labels = pullRequestLabels();
  if (changes.length && labels && !labels.includes("capability-change"))
    throw new Error(
      "Published models change request settings; a maintainer must add the capability-change label after checking them."
    );
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
