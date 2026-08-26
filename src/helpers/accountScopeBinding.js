// Persists the last VALIDATED account-scope binding so a boot without a
// resolvable session (offline, expired lease) can restore note visibility
// for the credential still on disk. The sha256 token fingerprint makes the
// file self-verifying: a rotated or replaced bearer no longer matches, so a
// stale binding degrades to "no restore", never to restoring the wrong
// account.
const { app } = require("electron");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const debugLogger = require("./debugLogger");

const BINDING_VERSION = 1;

const bindingFile = () => path.join(app.getPath("userData"), "account-scope-binding.json");

function hashToken(token) {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

// Pure gate for the set-active-account-scope IPC request. A null accountId
// arriving while a token exists is a "validated signed-out" transition and
// must carry the current generation, so a stray early null call cannot
// discard a valid binding.
function evaluateScopeRequest({ accountId, expectedGeneration, token, generation }) {
  if (accountId !== null && (typeof accountId !== "string" || accountId.trim().length === 0)) {
    return { ok: false, code: "INVALID_ACCOUNT" };
  }
  if (accountId !== null && !token) {
    return { ok: false, code: "AUTH_CONTEXT_CHANGED" };
  }
  if (token && generation !== expectedGeneration) {
    return { ok: false, code: "AUTH_CONTEXT_CHANGED" };
  }
  return { ok: true };
}

// Pure boot decision: restore only when the persisted bearer is the exact
// credential this binding was validated under.
function resolveBootAccountScope({ token, binding }) {
  if (typeof token !== "string" || token.length === 0) return null;
  if (!binding || binding.version !== BINDING_VERSION) return null;
  if (typeof binding.accountId !== "string" || binding.accountId.trim().length === 0) return null;
  if (binding.tokenHash !== hashToken(token)) return null;
  return binding.accountId;
}

function read() {
  try {
    const parsed = JSON.parse(fs.readFileSync(bindingFile(), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (err) {
    if (err?.code !== "ENOENT") {
      debugLogger.error("accountScopeBinding.read failed", { error: err?.message });
    }
    return null;
  }
}

function persist(accountId, token) {
  try {
    fs.writeFileSync(
      bindingFile(),
      JSON.stringify({ version: BINDING_VERSION, accountId, tokenHash: hashToken(token) }),
      { mode: 0o600 }
    );
  } catch (err) {
    debugLogger.error("accountScopeBinding.persist failed", { error: err?.message });
  }
}

function clear() {
  try {
    fs.rmSync(bindingFile(), { force: true });
  } catch (err) {
    debugLogger.error("accountScopeBinding.clear failed", { error: err?.message });
  }
}

module.exports = { clear, evaluateScopeRequest, hashToken, persist, read, resolveBootAccountScope };
