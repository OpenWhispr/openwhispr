// The catalog a canary probes, without retired models. `--published` probes what users
// actually receive between releases: the live signed publication, read exactly as the app
// reads it. Without the flag it probes the catalog this build bundles.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const bundled = require("../../src/models/modelRegistryData.json");
const { verifyEnvelope } = require("../../src/models/registryEnvelope.cjs");
const { validateManifest, acceptCatalog } = require("../../src/models/registrySchema.cjs");
const { REGISTRY_URL } = require("../../src/helpers/registryLoader.js");
const trustedKeys = require("../../src/models/registryTrustedKeys.json");
const { clientContract } = require("../../src/models/registryMetadata.json");
const { version: appVersion } = require("../../package.json");

function withoutRetired(catalog) {
  const visible = structuredClone(catalog);
  for (const section of [
    "cloudProviders",
    "enterpriseProviders",
    "transcriptionProviders",
    "localProviders",
  ])
    for (const provider of visible[section])
      provider.models = provider.models.filter((m) => !m.retired);
  return visible;
}

export async function loadCanaryCatalog(argv = process.argv) {
  if (!argv.includes("--published")) return withoutRetired(bundled);
  const response = await fetch(REGISTRY_URL, {
    signal: AbortSignal.timeout(15000),
    redirect: "error",
  });
  if (!response.ok) throw new Error(`Published catalog HTTP ${response.status}`);
  const manifest = validateManifest(
    verifyEnvelope(Buffer.from(await response.arrayBuffer()), trustedKeys)
  );
  // The app would refuse this catalog, so probing it would test something users never get.
  if (!manifest.testedClientContracts.includes(clientContract))
    throw new Error(
      `Published catalog ${manifest.manifestVersion} was not tested with this app's reader`
    );
  console.log(
    `Probing published catalog ${manifest.manifestVersion} (source ${manifest.sourceCommit})`
  );
  return withoutRetired(acceptCatalog(manifest.data, bundled, appVersion));
}
