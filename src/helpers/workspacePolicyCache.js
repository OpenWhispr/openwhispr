const fs = require("fs");

const CACHE_VERSION = 2;

function isIdentity(value) {
  return (
    value &&
    typeof value === "object" &&
    typeof value.apiOrigin === "string" &&
    typeof value.credentialHash === "string" &&
    (value.accountId === null || typeof value.accountId === "string")
  );
}

function readEnvelope(cachePath) {
  if (!fs.existsSync(cachePath)) return { version: CACHE_VERSION, entries: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    if (parsed?.version !== CACHE_VERSION || !Array.isArray(parsed.entries)) {
      return { version: CACHE_VERSION, entries: [] };
    }
    return parsed;
  } catch {
    return { version: CACHE_VERSION, entries: [] };
  }
}

function sameIdentity(left, right) {
  return left.apiOrigin === right.apiOrigin && left.credentialHash === right.credentialHash;
}

function readWorkspacePolicyCache(cachePath, identity) {
  if (!isIdentity(identity)) return null;
  const entry = readEnvelope(cachePath).entries.find(
    (candidate) => isIdentity(candidate?.identity) && sameIdentity(candidate.identity, identity)
  );
  return entry?.data && typeof entry.data === "object" ? entry.data : null;
}

function writeWorkspacePolicyCache(cachePath, identity, data) {
  if (!isIdentity(identity)) throw new Error("Complete policy cache identity is required");
  if (!data || typeof data !== "object") throw new Error("Policy cache data is required");
  const envelope = readEnvelope(cachePath);
  const entries = envelope.entries.filter(
    (entry) => !isIdentity(entry?.identity) || !sameIdentity(entry.identity, identity)
  );
  entries.push({ identity, data });
  fs.writeFileSync(cachePath, JSON.stringify({ version: CACHE_VERSION, entries }), { mode: 0o600 });
}

module.exports = { readWorkspacePolicyCache, writeWorkspacePolicyCache };
