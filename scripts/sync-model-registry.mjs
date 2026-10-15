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

export function createVendoredFiles({
  bytes,
  revision,
  contracts,
  runtimeContracts,
  runtimeContract,
  trustedKeys = pinnedKeys,
}) {
  if (!/^[a-f0-9]{40}$/.test(revision))
    throw new Error("Use an exact 40-character publication commit");
  const manifest = validateManifest(verifyEnvelope(bytes, trustedKeys));
  assertCompatibleCatalog(manifest.data, bundled);
  if (runtimeContracts || runtimeContract) {
    if (!runtimeContracts || !/^[a-f0-9]{40}$/.test(runtimeContract?.sourceCommit || ""))
      throw new Error("Use an exact 40-character runtime contract commit");
    if (
      Object.keys(runtimeContract).sort().join(",") !== "contractHashes,sourceCommit" ||
      Object.keys(runtimeContract.contractHashes || {})
        .sort()
        .join(",") !== Object.keys(names).sort().join(",")
    )
      throw new Error("Invalid runtime contract provenance");
  }
  const files = {};
  for (const [key, name] of Object.entries(names)) {
    if (hash(contracts[key]) !== manifest.contractHashes[key])
      throw new Error(`Contract digest mismatch: ${key}`);
    files[`registryPublished/${name}`] = contracts[key];
    if (runtimeContract) {
      if (
        !/^[a-f0-9]{64}$/.test(runtimeContract.contractHashes[key]) ||
        hash(runtimeContracts[key]) !== runtimeContract.contractHashes[key]
      )
        throw new Error(`Runtime contract digest mismatch: ${key}`);
      files[name] = runtimeContracts[key];
    } else files[name] = contracts[key];
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
    ...(runtimeContract ? { runtimeContract } : {}),
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
  const contractRevisionIndex = process.argv.indexOf("--contract-revision");
  if (check && contractRevisionIndex !== -1)
    throw new Error("--check uses the recorded runtime contract pin");
  const contractRevision = check
    ? metadata.runtimeContract?.sourceCommit
    : contractRevisionIndex === -1
      ? undefined
      : process.argv[contractRevisionIndex + 1];
  if (
    (contractRevisionIndex !== -1 || metadata?.runtimeContract) &&
    !/^[a-f0-9]{40}$/.test(contractRevision || "")
  )
    throw new Error("Pass --contract-revision <exact source commit>");
  const base = "https://raw.githubusercontent.com/OpenWhispr/model-registry";
  const bytes = check
    ? await fs.readFile(path.join(output, "registryBundle.json"), "utf8")
    : await fetchText(`${base}/${revision}/manifest.json`);
  const manifest = validateManifest(verifyEnvelope(bytes, pinnedKeys));
  const contracts = {};
  for (const [key, name] of Object.entries(names)) {
    contracts[key] = check
      ? await fs.readFile(path.join(output, "registryPublished", name), "utf8")
      : await fetchText(`${base}/${manifest.sourceCommit}/lib/${sourceNames[key]}`);
  }
  let runtimeContracts;
  let runtimeContract;
  if (contractRevision) {
    runtimeContracts = {};
    for (const [key, name] of Object.entries(names)) {
      runtimeContracts[key] = check
        ? await fs.readFile(path.join(output, name), "utf8")
        : await fetchText(`${base}/${contractRevision}/lib/${sourceNames[key]}`);
    }
    // This is a reviewed source pin, separate from the signed publication's contract hashes.
    runtimeContract = check
      ? metadata.runtimeContract
      : {
          sourceCommit: contractRevision,
          contractHashes: Object.fromEntries(
            Object.entries(runtimeContracts).map(([key, bytes]) => [key, hash(bytes)])
          ),
        };
  }
  const files = createVendoredFiles({
    bytes,
    revision,
    contracts,
    runtimeContracts,
    runtimeContract,
  });
  for (const [name, contents] of Object.entries(files)) {
    if (check) {
      if ((await fs.readFile(path.join(output, name), "utf8")) !== contents)
        throw new Error(`Generated registry file differs: ${name}`);
    } else {
      await fs.mkdir(path.dirname(path.join(output, name)), { recursive: true });
      await fs.writeFile(path.join(output, name), contents);
    }
  }
  console.log(
    `${check ? "Verified" : "Vendored"} signed model registry ${manifest.manifestVersion} from ${manifest.sourceCommit}` +
      (runtimeContract
        ? `; separate runtime contracts pinned to ${runtimeContract.sourceCommit}`
        : "")
  );
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
