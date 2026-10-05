const CANONICAL_APP_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function parseCanonicalAppVersion(value) {
  if (typeof value !== "string") return null;
  const match = CANONICAL_APP_VERSION.exec(value);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}

function isCanonicalAppVersion(value) {
  return parseCanonicalAppVersion(value) !== null;
}

module.exports = { isCanonicalAppVersion, parseCanonicalAppVersion };
