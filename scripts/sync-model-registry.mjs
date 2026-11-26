#!/usr/bin/env node
// Keeps the app's bundled model catalog and catalog reader (src/models) equal to the
// registry in this repository (model-registry/).
//   (no flag)        offline: regenerate the bundled files from model-registry/
//   --check          offline: the bundled files are exactly what model-registry/ produces
//   --status         online, informational: which publication is live, and was it tested
//                    with this app's reader?
//   --pin-release    online, for release builds: bundle the signed publication of this
//                    commit's catalog; fails when it is not published or the registry
//                    would stop serving this build. --revision <commit> names the commit
//                    of the published branch to read, so every platform bundles the same.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

const require = createRequire(import.meta.url);
const { verifyEnvelope, MAX_ENVELOPE_BYTES } = require("../src/models/registryEnvelope.cjs");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "src/models");
const registry = path.join(root, "model-registry");
const REPOSITORY = "https://github.com/OpenWhispr/openwhispr.git";
const PUBLISHED_BRANCH = "model-registry-published";
const BASE = "https://raw.githubusercontent.com/OpenWhispr/openwhispr";
// How far back a release looks for the publication of its own catalog: a release cut
// from an older commit bundles the publication made from it, not the newest one.
const HISTORY_DEPTH = 25;
const READER = {
  schema: ["registrySchema.cjs", "schema.cjs"],
  envelope: ["registryEnvelope.cjs", "envelope.cjs"],
  selection: ["registrySelection.js", "registrySelection.js"],
};
const KEYS = "registryTrustedKeys.json";
const HOW_TO_ADD =
  "These files are generated: add or change models in model-registry/, then run npm run model-registry:sync and commit both.";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (value) => JSON.stringify(value, null, 2) + "\n";
const isCommit = (value) => /^[a-f0-9]{40}$/.test(value || "");

// Every release job pins from raw.githubusercontent.com, so one network blip would fail a
// platform's release. Its URLs name a commit, so a repeated fetch reads the same bytes.
async function fetchText(url, attempts = 3) {
  const retry = async () => {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return fetchText(url, attempts - 1);
  };
  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(15000), redirect: "error" });
  } catch (error) {
    if (attempts > 1) return retry();
    throw error;
  }
  if (!response.ok) {
    if (attempts > 1 && (response.status === 429 || response.status >= 500)) return retry();
    const error = new Error(`${url} answered HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_ENVELOPE_BYTES) throw new Error(`${url} exceeds the size limit`);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function readerHashes(files) {
  return Object.fromEntries(Object.keys(READER).map((key) => [key, hash(files[key])]));
}

// What the app bundles for the registry in `from`: its reader and keys byte for byte, and
// its catalog as that reader validates it. `zod` resolves from model-registry/node_modules
// when it is installed there, otherwise from the app's.
export async function generate(from = registry) {
  const files = {};
  for (const [key, [, sourceName]] of Object.entries(READER))
    files[key] = await fs.readFile(path.join(from, "lib", sourceName), "utf8");
  const reader = require(path.join(from, "lib", "catalog.cjs"));
  const hashes = readerHashes(files);
  const catalog = json(reader.validateCatalog(reader.readCatalog(path.join(from, "registry"))));
  return {
    files,
    catalog,
    keys: await fs.readFile(path.join(from, "trusted-keys.json"), "utf8"),
    metadata: {
      schemaVersion: reader.SCHEMA_VERSION,
      // Not a publication: any signed publication replaces it at runtime. A release
      // build pins the publication of this catalog instead (--pin-release).
      manifestVersion: 0,
      publicationCommit: null,
      sourceCommit: null,
      contractHashes: hashes,
      clientContract: reader.contractId(hashes),
      catalogSha256: hash(catalog),
    },
  };
}

async function sync() {
  const { files, catalog, keys, metadata } = await generate();
  for (const [key, [name]] of Object.entries(READER))
    await fs.writeFile(path.join(output, name), files[key]);
  await fs.writeFile(path.join(output, KEYS), keys);
  await fs.writeFile(path.join(output, "modelRegistryData.json"), catalog);
  await fs.rm(path.join(output, "registryBundle.json"), { force: true });
  await fs.writeFile(path.join(output, "registryMetadata.json"), json(metadata));
  return `Bundled the catalog from model-registry/ (reader ${metadata.clientContract.slice(0, 12)})`;
}

export async function check(dir = output, from = registry) {
  const read = (name) => fs.readFile(path.join(dir, name), "utf8");
  const fail = (message) => {
    throw new Error(`${message}\n${HOW_TO_ADD}`);
  };
  const expected = await generate(from);
  for (const [key, [name]] of Object.entries(READER))
    if ((await read(name)) !== expected.files[key])
      fail(`${name} differs from model-registry/lib/${READER[key][1]}.`);
  if ((await read(KEYS)) !== expected.keys)
    fail(`${KEYS} differs from model-registry/trusted-keys.json.`);
  const catalog = await read("modelRegistryData.json");
  if (catalog !== expected.catalog)
    fail("modelRegistryData.json differs from the catalog in model-registry/registry.");
  const metadata = JSON.parse(await read("registryMetadata.json"));
  for (const field of ["schemaVersion", "contractHashes", "clientContract", "catalogSha256"])
    if (JSON.stringify(metadata[field]) !== JSON.stringify(expected.metadata[field]))
      fail(`registryMetadata.json has a stale ${field}.`);
  // A reader the registry doesn't keep a copy of stops being tested by later publications,
  // and a release build refuses it. Caught here, a changed reader fails its own pull
  // request instead of the release cut from it.
  try {
    await fs.access(path.join(from, "compat", "clients", metadata.clientContract, "client.json"));
  } catch {
    throw new Error(
      `The catalog reader changed, and model-registry/compat/clients has no copy of it (${metadata.clientContract}).\n` +
        "Add one: the three reader files from model-registry/lib, floor.json (the catalog the release bundles) " +
        "and client.json naming the first app version that ships it. See model-registry/README.md."
    );
  }
  let bundle = null;
  try {
    bundle = await read("registryBundle.json");
  } catch {}
  if (metadata.publicationCommit) {
    // A release build's tree: the pinned publication must be this exact catalog.
    if (!bundle) fail("A pinned publication needs registryBundle.json.");
    const reader = require(path.join(dir, "registrySchema.cjs"));
    const manifest = reader.validateManifest(verifyEnvelope(bundle, JSON.parse(expected.keys)));
    if (
      manifest.manifestVersion !== metadata.manifestVersion ||
      manifest.sourceCommit !== metadata.sourceCommit ||
      JSON.stringify(manifest.contractHashes) !== JSON.stringify(metadata.contractHashes) ||
      json(reader.validateCatalog(manifest.data)) !== catalog
    )
      fail("The bundled catalog does not match its signed publication.");
    return `signed publication ${metadata.manifestVersion}`;
  }
  if (bundle || metadata.manifestVersion !== 0)
    fail("Outside a release build the bundle has version 0 and no signed publication.");
  return "the catalog in model-registry/";
}

async function readLocal(dir = output) {
  const read = (name) => fs.readFile(path.join(dir, name), "utf8");
  return {
    metadata: JSON.parse(await read("registryMetadata.json")),
    catalog: await read("modelRegistryData.json"),
    keys: JSON.parse(await read(KEYS)),
    reader: require(path.join(dir, "registrySchema.cjs")),
  };
}

function publishedTip() {
  const line = execFileSync("git", ["ls-remote", REPOSITORY, `refs/heads/${PUBLISHED_BRANCH}`], {
    encoding: "utf8",
    timeout: 30000,
  });
  const commit = line.split(/\s/)[0];
  if (!isCommit(commit)) throw new Error(`No ${PUBLISHED_BRANCH} branch on ${REPOSITORY}`);
  return commit;
}

async function status() {
  const { metadata, keys, reader } = await readLocal();
  const manifest = reader.validateManifest(
    verifyEnvelope(await fetchText(`${BASE}/${PUBLISHED_BRANCH}/v2/manifest.json`), keys)
  );
  const tested = manifest.testedClientContracts.includes(metadata.clientContract);
  return [
    `Live publication ${manifest.manifestVersion} (source ${manifest.sourceCommit}).`,
    tested
      ? "It was tested with this app's reader."
      : "It was NOT tested with this app's reader; add the reader under model-registry/compat/clients before release.",
  ].join("\n");
}

// The publication a release bundles: the newest one whose catalog and reader are exactly
// this commit's. `candidates` are verified manifests, newest first.
export function choosePublication({ candidates, metadata, catalog, reader }) {
  return (
    candidates.find(
      (manifest) =>
        JSON.stringify(manifest.contractHashes) === JSON.stringify(metadata.contractHashes) &&
        json(reader.validateCatalog(manifest.data)) === catalog
    ) || null
  );
}

// A build the registry doesn't test applies no publication, ever, and only logs a warning.
// The reader's copy under compat/clients is required by check(), which every build runs.
export function releaseProblems({ manifest, liveVersion, liveTested, clientContract }) {
  if (!manifest)
    return [
      `The model catalog at this commit is not published (live publication is ${liveVersion}). ` +
        'If its "Publish model registry" run is waiting for approval, approve it and run the release again. ' +
        "If a later registry change was published instead, this commit's catalog never will be: " +
        "release from a commit that has that later change.",
    ];
  const problems = [];
  if (!liveTested) problems.push("The live publication was not tested with this app's reader.");
  if (!manifest.testedClientContracts.includes(clientContract))
    problems.push("The publication of this catalog was not tested with this app's reader.");
  return problems;
}

// `dir`, `from`, `fetchFile` and `tip` are replaced in tests, which pin offline.
export async function pinRelease(
  revision,
  { dir = output, from = registry, fetchFile = fetchText, tip = publishedTip } = {}
) {
  const { metadata, catalog, keys, reader } = await readLocal(dir);
  await check(dir, from);
  // `revision` is null when the flag is absent. Given without a commit (an empty output
  // from an earlier job), it must not quietly become whatever is live now.
  if (revision !== null && !isCommit(revision))
    throw new Error("--revision takes a commit of the published branch");
  const commit = revision ?? tip();
  const at = `${BASE}/${commit}/v2`;
  const load = async (file) => {
    const bytes = await fetchFile(`${at}/${file}`);
    return { bytes, manifest: reader.validateManifest(verifyEnvelope(bytes, keys)) };
  };
  const live = await load("manifest.json");
  const candidates = [live];
  const oldest = Math.max(1, live.manifest.manifestVersion - HISTORY_DEPTH);
  let chosen = choosePublication({
    candidates: [live.manifest],
    metadata,
    catalog,
    reader,
  });
  for (let version = live.manifest.manifestVersion - 1; !chosen && version >= oldest; version--) {
    let earlier;
    try {
      earlier = await load(`history/${version}.json`);
    } catch (error) {
      // The v2 history starts where the retired v1 format stopped.
      if (error.status === 404) break;
      throw error;
    }
    candidates.push(earlier);
    chosen = choosePublication({ candidates: [earlier.manifest], metadata, catalog, reader });
  }
  const problems = releaseProblems({
    manifest: chosen,
    liveVersion: live.manifest.manifestVersion,
    liveTested: live.manifest.testedClientContracts.includes(metadata.clientContract),
    clientContract: metadata.clientContract,
  });
  if (problems.length) throw new Error(problems.join("\n"));
  const { bytes } = candidates.find((candidate) => candidate.manifest === chosen);
  await fs.writeFile(path.join(dir, "registryBundle.json"), json(JSON.parse(bytes)));
  await fs.writeFile(
    path.join(dir, "registryMetadata.json"),
    json({
      ...metadata,
      manifestVersion: chosen.manifestVersion,
      publicationCommit: commit,
      sourceCommit: chosen.sourceCommit,
    })
  );
  await check(dir, from);
  return `Pinned signed publication ${chosen.manifestVersion} at ${commit} (live is ${live.manifest.manifestVersion}).`;
}

async function main() {
  const argument = (flag) => {
    const index = process.argv.indexOf(flag);
    return index === -1 ? null : (process.argv[index + 1] ?? "");
  };
  if (process.argv.includes("--check")) return `Verified: the app bundles ${await check()}`;
  if (process.argv.includes("--status")) return status();
  if (process.argv.includes("--pin-release")) return pinRelease(argument("--revision"));
  if (process.argv.length > 2)
    throw new Error("Pass no flag to regenerate, or --check, --status or --pin-release");
  return sync();
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
