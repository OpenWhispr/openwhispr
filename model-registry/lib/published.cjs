const { verifyEnvelope, MAX_ENVELOPE_BYTES } = require("./envelope.cjs");
const { readPreviousManifest } = require("./publication.cjs");
const trusted = require("../trusted-keys.json");

const BASE = "https://raw.githubusercontent.com/OpenWhispr/model-registry/published";

async function readBounded(response) {
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > MAX_ENVELOPE_BYTES) throw new Error("Publication too large");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

// The latest signed publication: v2 once it exists, otherwise the last v1 manifest,
// whose version and data the v2 sequence continues.
async function fetchPublished(fetch = globalThis.fetch) {
  for (const file of ["v2/manifest.json", "manifest.json"]) {
    const response = await fetch(`${BASE}/${file}`, {
      signal: AbortSignal.timeout(15000),
      redirect: "error",
    });
    if (response.status === 404) continue;
    if (!response.ok) throw new Error(`Publication ${file} HTTP ${response.status}`);
    return readPreviousManifest(verifyEnvelope(await readBounded(response), trusted));
  }
  return null;
}

module.exports = { fetchPublished };
