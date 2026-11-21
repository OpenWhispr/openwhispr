const { readCatalog } = require("../lib/catalog.cjs");
const { changedArtifacts, verifyArtifact } = require("../lib/artifacts.cjs");
const { fetchPublished } = require("../lib/published.cjs");
const seed = require("../test/seed.json");

(async () => {
  const previous = await fetchPublished();
  const artifacts = changedArtifacts(readCatalog(), previous?.data ?? seed);
  const problems = [];
  for (const artifact of artifacts) problems.push(...(await verifyArtifact(artifact)));
  if (problems.length) throw new Error(`Downloads do not match the catalog:\n${problems.join("\n")}`);
  console.log(`Checked ${artifacts.length} new or changed downloads against their sources.`);
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
