const { app } = require("electron");
const fs = require("fs");
const path = require("path");
const debugLogger = require("./debugLogger");
const secretCrypto = require("./secretCrypto");

const tokenFile = () => path.join(app.getPath("userData"), "auth-token.bin");

let cached = null;

function get() {
  if (cached !== null) return cached || null;
  try {
    const file = tokenFile();
    if (!fs.existsSync(file)) return (cached = "");
    const buf = fs.readFileSync(file);
    if (!secretCrypto.isAvailable()) {
      cached = buf.toString("utf8");
      return cached || null;
    }
    const { value, needsReencrypt } = secretCrypto.decrypt(buf);
    cached = value;
    if (needsReencrypt) set(value);
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
    const data = secretCrypto.isAvailable()
      ? secretCrypto.encrypt(token)
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
