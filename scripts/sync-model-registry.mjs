#!/usr/bin/env node
// Vendors the model catalog and its reader from OpenWhispr/model-registry.
//   --revision <commit>  a signed publication (a commit on the registry's `published` branch)
//   --source <commit>    an unpublished registry source commit, for review builds only
//   --check              offline: the vendored files are exactly what was synced
//   --status             online, informational: is a newer publication live, and has it
//                        been tested with this app's reader?
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { verifyEnvelope, MAX_ENVELOPE_BYTES } = require("../src/models/registryEnvelope.cjs");
const pinnedKeys = require("../src/models/registryTrustedKeys.json");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "src/models");
const BASE = "https://raw.githubusercontent.com/OpenWhispr/model-registry";
const READER = {
  schema: ["registrySchema.cjs", "schema.cjs"],
  envelope: ["registryEnvelope.cjs", "envelope.cjs"],
  selection: ["registrySelection.js", "registrySelection.js"],
};
const SECTIONS = {
  parakeetModels: "parakeet",
  whisperModels: "whisper",
  transcriptionProviders: "transcription-providers",
  cloudProviders: "cloud-providers",
  enterpriseProviders: "enterprise-providers",
  localProviders: "local-gguf",
};
const HOW_TO_ADD =
  "modelRegistryData.json is generated: add or change models in OpenWhispr/model-registry, then run npm run model-registry:sync -- --revision <publication commit>.";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (value) => JSON.stringify(value, null, 2) + "\n";
const isCommit = (value) => /^[a-f0-9]{40}$/.test(value || "");

async function fetchText(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15000), redirect: "error" });
  if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_ENVELOPE_BYTES) throw new Error(`${url} exceeds the size limit`);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

// The downloaded reader validates the catalog it arrived with, so a schema change is
// adopted in the same sync. It loads beside node_modules so its `zod` import resolves.
async function loadReader(files) {
  const dir = path.join(root, "node_modules", ".cache", `model-registry-${hash(files.schema)}`);
  await fs.mkdir(dir, { recursive: true });
  for (const [key, [, sourceName]] of Object.entries(READER))
    await fs.writeFile(path.join(dir, sourceName), files[key]);
  return require(path.join(dir, "schema.cjs"));
}

function readerHashes(files) {
  return Object.fromEntries(Object.keys(READER).map((key) => [key, hash(files[key])]));
}

async function writeVendored({ files, data, bundle, metadata }) {
  for (const [key, [name]] of Object.entries(READER))
    await fs.writeFile(path.join(output, name), files[key]);
  const catalog = json(data);
  await fs.writeFile(path.join(output, "modelRegistryData.json"), catalog);
  const bundlePath = path.join(output, "registryBundle.json");
  if (bundle) await fs.writeFile(bundlePath, json(bundle));
  else await fs.rm(bundlePath, { force: true });
  await fs.writeFile(
    path.join(output, "registryMetadata.json"),
    json({ ...metadata, catalogSha256: hash(catalog) })
  );
}

async function syncPublication(revision) {
  const at = `${BASE}/${revision}/v2`;
  const bytes = await fetchText(`${at}/manifest.json`);
  const files = {};
  for (const [key, [, sourceName]] of Object.entries(READER))
    files[key] = await fetchText(`${at}/${sourceName}`);
  // The signature is checked with the app's current code and pinned keys, and the
  // downloaded reader must match the signed hashes before any of it runs.
  const payload = verifyEnvelope(bytes, pinnedKeys);
  const hashes = readerHashes(files);
  for (const key of Object.keys(READER))
    if (hashes[key] !== payload?.contractHashes?.[key])
      throw new Error(`Reader file ${key} does not match the signed publication`);
  const reader = await loadReader(files);
  const manifest = reader.validateManifest(payload);
  const data = reader.validateCatalog(manifest.data);
  await writeVendored({
    files,
    data,
    bundle: JSON.parse(bytes),
    metadata: {
      schemaVersion: manifest.schemaVersion,
      manifestVersion: manifest.manifestVersion,
      publicationCommit: revision,
      sourceCommit: manifest.sourceCommit,
      contractHashes: hashes,
      clientContract: reader.contractId(hashes),
    },
  });
  return `signed publication ${manifest.manifestVersion} (source ${manifest.sourceCommit})`;
}

async function syncSource(sourceCommit) {
  const at = `${BASE}/${sourceCommit}`;
  const files = {};
  for (const [key, [, sourceName]] of Object.entries(READER))
    files[key] = await fetchText(`${at}/lib/${sourceName}`);
  const reader = await loadReader(files);
  const read = async (name) => JSON.parse(await fetchText(`${at}/registry/${name}.json`));
  const legacy = await read("legacy");
  const catalog = {
    diarizationModels: legacy.diarizationModels,
    openwhisprCloudModels: legacy.openwhisprCloudModels,
  };
  for (const [section, name] of Object.entries(SECTIONS)) catalog[section] = await read(name);
  const data = reader.validateCatalog(catalog);
  const hashes = readerHashes(files);
  await writeVendored({
    files,
    data,
    bundle: null,
    metadata: {
      schemaVersion: reader.SCHEMA_VERSION,
      // Unpublished: any signed publication replaces it at runtime.
      manifestVersion: 0,
      publicationCommit: null,
      sourceCommit,
      contractHashes: hashes,
      clientContract: reader.contractId(hashes),
    },
  });
  return `UNPUBLISHED source ${sourceCommit}; re-sync from its publication before release`;
}

export async function check(dir = output) {
  const read = (name) => fs.readFile(path.join(dir, name), "utf8");
  const metadata = JSON.parse(await read("registryMetadata.json"));
  const files = {};
  for (const [key, [name]] of Object.entries(READER)) files[key] = await read(name);
  const hashes = readerHashes(files);
  const reader = require(path.join(dir, "registrySchema.cjs"));
  const catalog = await read("modelRegistryData.json");
  const fail = (message) => {
    throw new Error(`${message}\n${HOW_TO_ADD}`);
  };
  if (JSON.stringify(hashes) !== JSON.stringify(metadata.contractHashes))
    fail("The vendored registry reader differs from the synced one.");
  if (metadata.clientContract !== reader.contractId(hashes)) fail("clientContract is stale.");
  if (hash(catalog) !== metadata.catalogSha256) fail("modelRegistryData.json was edited by hand.");
  reader.validateCatalog(JSON.parse(catalog));
  let bundle = null;
  try {
    bundle = await read("registryBundle.json");
  } catch {}
  if (metadata.publicationCommit) {
    if (!bundle) fail("A published snapshot needs registryBundle.json.");
    const manifest = reader.validateManifest(verifyEnvelope(bundle, pinnedKeys));
    if (
      manifest.manifestVersion !== metadata.manifestVersion ||
      manifest.sourceCommit !== metadata.sourceCommit ||
      JSON.stringify(manifest.contractHashes) !== JSON.stringify(hashes) ||
      json(reader.validateCatalog(manifest.data)) !== catalog
    )
      fail("The vendored catalog does not match its signed publication.");
    return `signed publication ${metadata.manifestVersion}`;
  }
  if (bundle || metadata.manifestVersion !== 0)
    fail("An unpublished snapshot has version 0 and no bundle.");
  return `UNPUBLISHED source ${metadata.sourceCommit}`;
}

async function status() {
  const metadata = JSON.parse(
    await fs.readFile(path.join(output, "registryMetadata.json"), "utf8")
  );
  const reader = require(path.join(output, "registrySchema.cjs"));
  const manifest = reader.validateManifest(
    verifyEnvelope(await fetchText(`${BASE}/published/v2/manifest.json`), pinnedKeys)
  );
  const tested = manifest.testedClientContracts.includes(metadata.clientContract);
  return [
    `Live publication ${manifest.manifestVersion}; this build bundles ${metadata.manifestVersion}.`,
    tested
      ? "The live publication was tested with this app's reader."
      : "The live publication was NOT tested with this app's reader; add it under compat/clients in the registry before release.",
  ].join("\n");
}

async function main() {
  const argument = (flag) => {
    const index = process.argv.indexOf(flag);
    return index === -1 ? undefined : process.argv[index + 1];
  };
  if (process.argv.includes("--check")) return `Verified ${await check()}`;
  if (process.argv.includes("--status")) return status();
  const revision = argument("--revision");
  const source = argument("--source");
  if (isCommit(revision)) return `Vendored ${await syncPublication(revision)}`;
  if (isCommit(source)) return `Vendored ${await syncSource(source)}`;
  throw new Error(
    "Pass --revision <publication commit>, --source <source commit>, --check or --status"
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (message) => console.log(message),
    (error) => {
      console.error(error.message);
      process.exitCode = 1;
    }
  );
}
