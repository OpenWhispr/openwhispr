#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { verifyEnvelope, MAX_ENVELOPE_BYTES } = require("../src/models/registryEnvelope.cjs");
const { validateManifest, assertCompatibleCatalog } = require("../src/models/registrySchema.cjs");
const pinnedKeys = require("../src/models/registryTrustedKeys.json");
const bundled = require("../src/models/modelRegistryData.json");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "src/models");
const names = {
  schema: "registrySchema.cjs",
  envelope: "registryEnvelope.cjs",
  selection: "registrySelection.js",
};
const sourceNames = {
  schema: "schema.cjs",
  envelope: "envelope.cjs",
  selection: "registrySelection.js",
};
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (value) => JSON.stringify(value, null, 2) + "\n";

export function createVendoredFiles({ bytes, revision, contracts, trustedKeys = pinnedKeys }) {
  if (!/^[a-f0-9]{40}$/.test(revision))
    throw new Error("Use an exact 40-character publication commit");
  const manifest = validateManifest(verifyEnvelope(bytes, trustedKeys));
  assertCompatibleCatalog(manifest.data, bundled);
  const files = {};
  for (const [key, name] of Object.entries(names)) {
    if (hash(contracts[key]) !== manifest.contractHashes[key])
      throw new Error(`Contract digest mismatch: ${key}`);
    files[name] = contracts[key];
  }
  files["modelRegistryData.json"] = json(manifest.data);
  files["registryBundle.json"] = json(JSON.parse(bytes));
  files["registryMetadata.json"] = json({
    schemaVersion: manifest.schemaVersion,
    manifestVersion: manifest.manifestVersion,
    publicationCommit: revision,
    sourceCommit: manifest.sourceCommit,
    contractHashes: manifest.contractHashes,
    payloadSha256: hash(Buffer.from(JSON.parse(bytes).payload, "base64")),
  });
  return files;
}

async function fetchText(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15000), redirect: "error" });
  if (!response.ok) throw new Error(`Registry source HTTP ${response.status}`);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_ENVELOPE_BYTES) throw new Error("Registry source exceeds size limit");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const check = process.argv.includes("--check");
  const metadata = check
    ? JSON.parse(await fs.readFile(path.join(output, "registryMetadata.json"), "utf8"))
    : null;
  const revision = check
    ? metadata.publicationCommit
    : process.argv[process.argv.indexOf("--revision") + 1];
  if (!/^[a-f0-9]{40}$/.test(revision || ""))
    throw new Error("Pass --revision <exact publication commit> or --check");
  const base = "https://raw.githubusercontent.com/OpenWhispr/model-registry";
  const bytes = check
    ? await fs.readFile(path.join(output, "registryBundle.json"), "utf8")
    : await fetchText(`${base}/${revision}/manifest.json`);
  const manifest = validateManifest(verifyEnvelope(bytes, pinnedKeys));
  const contracts = {};
  for (const [key, name] of Object.entries(names)) {
    contracts[key] = check
      ? await fs.readFile(path.join(output, name), "utf8")
      : await fetchText(`${base}/${manifest.sourceCommit}/lib/${sourceNames[key]}`);
  }
  const files = createVendoredFiles({ bytes, revision, contracts });
  for (const [name, contents] of Object.entries(files)) {
    if (check) {
      if ((await fs.readFile(path.join(output, name), "utf8")) !== contents)
        throw new Error(`Generated registry file differs: ${name}`);
    } else await fs.writeFile(path.join(output, name), contents);
  }
  console.log(
    `${check ? "Verified" : "Vendored"} signed model registry ${manifest.manifestVersion} from ${manifest.sourceCommit}`
  );
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
