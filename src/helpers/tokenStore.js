const { safeStorage, app } = require("electron");
const fs = require("fs");
const path = require("path");
const debugLogger = require("./debugLogger");

const tokenFile = () => path.join(app.getPath("userData"), "auth-token.bin");

let cached = null;

function get() {
  if (cached !== null) return cached || null;
  try {
    const file = tokenFile();
    if (!fs.existsSync(file)) return (cached = "");
    const buf = fs.readFileSync(file);
    cached = safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(buf)
      : buf.toString("utf8");
    return cached || null;
  } catch (err) {
    debugLogger.error("tokenStore.get failed", { error: err?.message });
    cached = "";
    return null;
  }
}

function set(token) {
  try {
    const file = tokenFile();
    const data = safeStorage.isEncryptionAvailable()
      ? safeStorage.encryptString(token)
      : Buffer.from(token, "utf8");
    fs.writeFileSync(file, data, { mode: 0o600 });
    cached = token;
  } catch (err) {
    debugLogger.error("tokenStore.set failed", { error: err?.message });
  }
}

function clear() {
  cached = "";
  try {
    fs.rmSync(tokenFile(), { force: true });
  } catch (err) {
    debugLogger.error("tokenStore.clear failed", { error: err?.message });
  }
}

module.exports = { get, set, clear };
