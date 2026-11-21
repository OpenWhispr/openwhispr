// Stores the claude setup token with safeStorage. Deliberately NOT one of the
// SECRET_KEYS in environment.js: those are loaded into process.env, which
// would leak the token into every child process the app spawns. The token is
// read only when a claude run starts and goes to the child env, never argv.
const path = require("path");
const nodeFs = require("fs");

const TOKEN_FILE = "llm-cli-claude-oauth.bin";

function createTokenStore({ fs = nodeFs, safeStorage, dir } = {}) {
  if (!safeStorage || typeof dir !== "string" || dir.length === 0) {
    throw new Error("safeStorage and dir are required");
  }
  const file = path.join(dir, TOKEN_FILE);

  return {
    file,
    save(token) {
      if (typeof token !== "string" || token.length === 0) {
        const err = new Error("token must be a non-empty string");
        err.code = "invalid-input";
        throw err;
      }
      // No plaintext fallback: without OS encryption nothing is written.
      if (!safeStorage.isEncryptionAvailable()) {
        const err = new Error("OS encryption is unavailable");
        err.code = "encryption-unavailable";
        throw err;
      }
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, safeStorage.encryptString(token), { mode: 0o600 });
    },
    load() {
      try {
        return safeStorage.decryptString(fs.readFileSync(file));
      } catch {
        return null;
      }
    },
    has() {
      return fs.existsSync(file);
    },
    clear() {
      fs.rmSync(file, { force: true });
    },
  };
}

module.exports = { createTokenStore, TOKEN_FILE };
