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

function compareAppVersions(leftVersion, rightVersion) {
  const left = parseCanonicalAppVersion(leftVersion);
  const right = parseCanonicalAppVersion(rightVersion);
  if (!left) return right ? -1 : 0;
  if (!right) return 1;
  for (let index = 0; index < left.length; index += 1) {
    const difference = left[index] - right[index];
    if (difference !== 0) return difference;
  }
  return 0;
}

module.exports = { compareAppVersions, isCanonicalAppVersion, parseCanonicalAppVersion };
