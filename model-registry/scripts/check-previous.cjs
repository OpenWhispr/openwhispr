const fs = require("node:fs");
const {
  readCatalog,
  assertCompatibleCatalog,
  capabilityChanges,
  capabilityChangeApproved,
} = require("../lib/catalog.cjs");
const { fetchPublished } = require("../lib/published.cjs");
const { assertReadersKept } = require("../lib/publication.cjs");
const { checkCompatibility, droppedClients } = require("../lib/compat.cjs");
const seed = require("../test/seed.json");

// Null outside a pull request, where there is no label to ask for.
function pullRequestEvent() {
  if (!process.env.GITHUB_EVENT_PATH) return null;
  const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  return event.pull_request ? event : null;
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
  const event = pullRequestEvent();
  if (changes.length && event && !capabilityChangeApproved(event))
    throw new Error(
      "Published models change request settings; a maintainer must add the capability-change label after checking them " +
        "(if it is already there, remove it and add it again: it covers only the commits it was added to)."
    );
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
