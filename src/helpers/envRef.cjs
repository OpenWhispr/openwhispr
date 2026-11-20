// Pure $VAR helpers for the main process. Keep in lockstep with envRef.ts (renderer).
const ENV_REF_RE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$|^\$([A-Za-z_][A-Za-z0-9_]*)$/;

function isEnvRef(value) {
  if (typeof value !== "string") return false;
  return ENV_REF_RE.test(value.trim());
}

function envRefName(value) {
  if (typeof value !== "string") return null;
  const match = value.trim().match(ENV_REF_RE);
  if (!match) return null;
  return match[1] || match[2];
}

// Never put a leftover $VAR on the wire as a credential.
function usableSecret(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return !trimmed || isEnvRef(trimmed) ? "" : trimmed;
}

function classifySecretInput(value, selfEnvName, allowedNames) {
  const name = envRefName(value);
  if (!name) return null;
  if (selfEnvName && name === selfEnvName) return "self-reference";
  if (allowedNames && !allowedNames.has(name)) return "unknown-ref";
  return null;
}

module.exports = {
  ENV_REF_RE,
  isEnvRef,
  envRefName,
  usableSecret,
  classifySecretInput,
};
