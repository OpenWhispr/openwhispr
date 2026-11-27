const { createHash } = require("node:crypto");
const trustedPublishers = require("../registry/trusted-publishers.json");
const { MAX_MANIFEST_BYTES, parseChecksums } = require("./qwen3AsrManifest.cjs");

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function listArtifacts(catalog) {
  const artifacts = [];
  for (const provider of catalog.localProviders || [])
    for (const model of provider.models) {
      const resolve = (repo, rev, file) =>
        `https://huggingface.co/${repo}/resolve/${rev || "main"}/${file}`;
      artifacts.push({
        key: `localProviders/${provider.id}/${model.id}`,
        kind: "gguf",
        url: resolve(model.hfRepo, model.revision, model.fileName),
        sha256: model.sha256,
        size: model.sizeBytes,
      });
      if (model.draftFileName)
        artifacts.push({
          key: `localProviders/${provider.id}/${model.id}#draft`,
          kind: "gguf",
          url: resolve(model.draftHfRepo, model.draftRevision, model.draftFileName),
          sha256: model.draftSha256,
          size: model.draftSizeBytes,
        });
    }
  for (const [section, kind] of [
    ["whisperModels", "whisper"],
    ["parakeetModels", "archive"],
  ])
    for (const [id, model] of Object.entries(catalog[section] || {}))
      artifacts.push({
        key: `${section}/${id}`,
        kind: model.modelType === "qwen3-asr" ? "checksums" : kind,
        url: model.downloadUrl,
        sha256: model.sha256,
        size: model.expectedSizeBytes,
      });
  return artifacts;
}

// New downloads, and downloads whose location, hash or size changed since `previous`.
function changedArtifacts(next, previous) {
  const before = new Map(listArtifacts(previous).map((artifact) => [artifact.key, artifact]));
  return listArtifacts(next).filter((artifact) => !same(artifact, before.get(artifact.key)));
}

const API_TIMEOUT_MS = 60 * 1000;
const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;

async function readJson(fetch, url) {
  const headers = { accept: "application/json" };
  // Unauthenticated GitHub API calls are limited to 60 an hour.
  if (url.startsWith("https://api.github.com/") && process.env.GITHUB_TOKEN)
    headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(API_TIMEOUT_MS) });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`);
  return response.json();
}

async function hashDownload(fetch, url, maxBytes, onChunk) {
  const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`);
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of response.body) {
    hash.update(chunk);
    size += chunk.length;
    if (size > maxBytes) throw new Error(`${url} is larger than its release asset size`);
    onChunk?.(chunk);
  }
  return { sha256: hash.digest("hex"), size };
}

async function checkBundle(artifact, url, fetch, listing, directory) {
  const chunks = [];
  const manifest = await hashDownload(fetch, url.href, MAX_MANIFEST_BYTES, (chunk) =>
    chunks.push(chunk)
  );
  if (manifest.sha256 !== artifact.sha256)
    return [`manifest sha256 is ${manifest.sha256}, catalog says ${artifact.sha256}`];
  const entries = parseChecksums(Buffer.concat(chunks).toString("utf8"));
  let total = 0;
  for (const { name, sha256 } of entries) {
    const file = directory ? directory + "/" + name : name;
    const entry = listing.find((item) => item.path === file);
    if (!entry) return [`${file} does not exist at the pinned revision`];
    const size = entry.lfs?.size ?? entry.size;
    if (!Number.isSafeInteger(size) || size <= 0) return [`${file} has invalid size`];
    const digest =
      entry.lfs?.oid ?? (await hashDownload(fetch, new URL(name, url).href, size)).sha256;
    if (digest !== sha256) return [`${file} sha256 is ${digest}, manifest says ${sha256}`];
    total += size;
  }
  return total === artifact.size ? [] : [`bundle size is ${total}, catalog says ${artifact.size}`];
}

async function checkHuggingFace(artifact, url, fetch) {
  const [, org, repo, , revision, ...rest] = url.pathname.split("/");
  const file = rest.join("/");
  const problems = [];
  if (!trustedPublishers.huggingFace.includes(org))
    problems.push(`${org} is not a trusted Hugging Face publisher (registry/trusted-publishers.json)`);
  const directory = rest.slice(0, -1).join("/");
  const treeUrl = new URL(`https://huggingface.co/api/models/${org}/${repo}/tree/${revision}${directory ? `/${directory}` : ""}`);
  if (artifact.kind === "checksums") treeUrl.searchParams.set("recursive", "true");
  const listing = await readJson(fetch, treeUrl.href);
  const entry = listing?.find((item) => item.path === file);
  if (!entry) return [...problems, `${file} does not exist in ${org}/${repo} at ${revision}`];
  if (artifact.kind === "checksums") {
    return [...problems, ...(await checkBundle(artifact, url, fetch, listing, directory))];
  }
  const actual = { sha256: entry.lfs?.oid, size: entry.lfs?.size ?? entry.size };
  if (artifact.sha256 && actual.sha256 !== artifact.sha256)
    problems.push(`sha256 is ${actual.sha256 ?? "not published"}, catalog says ${artifact.sha256}`);
  if (artifact.size && actual.size !== artifact.size)
    problems.push(`size is ${actual.size}, catalog says ${artifact.size}`);
  if (artifact.kind === "gguf") {
    const head = await fetch(url.href, {
      headers: { range: "bytes=0-3" },
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    const magic = Buffer.from(await head.arrayBuffer()).subarray(0, 4).toString("latin1");
    if (magic !== "GGUF") problems.push(`is not a GGUF file (starts with ${JSON.stringify(magic)})`);
  }
  return problems;
}

async function checkGitHubRelease(artifact, url, fetch) {
  const [, owner, repo, , , tag, name] = url.pathname.split("/");
  const release = await readJson(
    fetch,
    `https://api.github.com/repos/${owner}/${repo}/releases/tags/${tag}`
  );
  const asset = release?.assets?.find((item) => item.name === name);
  if (!asset) return [`${name} is not attached to ${owner}/${repo} release ${tag}`];
  const problems = [];
  if (artifact.size && asset.size !== artifact.size)
    problems.push(`size is ${asset.size}, catalog says ${artifact.size}`);
  if (!artifact.sha256) return problems;
  const digest = asset.digest?.startsWith("sha256:")
    ? asset.digest.slice(7)
    : (await hashDownload(fetch, url.href, asset.size)).sha256;
  if (digest !== artifact.sha256) problems.push(`sha256 is ${digest}, catalog says ${artifact.sha256}`);
  return problems;
}

// Proves a catalog entry against the real file: it exists, its hash and size match, and
// it is the kind of file its engine loads. Wrong or placeholder hashes cannot merge.
async function verifyArtifact(artifact, { fetch = globalThis.fetch } = {}) {
  const url = new URL(artifact.url);
  const problems =
    url.hostname === "huggingface.co"
      ? await checkHuggingFace(artifact, url, fetch)
      : await checkGitHubRelease(artifact, url, fetch);
  return problems.map((problem) => `${artifact.key}: ${problem}`);
}

module.exports = { listArtifacts, changedArtifacts, verifyArtifact };
