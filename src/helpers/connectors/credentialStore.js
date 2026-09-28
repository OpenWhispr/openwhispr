const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { describeError } = require("./errorSummary");

const CONNECTOR_ID_PATTERN = /^[a-z][a-z0-9-]*$/;

function createCredentialStore({ dir, secretCrypto, logger, fsImpl = fs }) {
  // Generations live in memory: pending actions die with the process, so the
  // counter only has to be monotonic within one run.
  const generations = new Map();

  function fileFor(connectorId) {
    if (!CONNECTOR_ID_PATTERN.test(connectorId)) {
      throw new Error(`Invalid connector id: ${connectorId}`);
    }
    return path.join(dir, `${connectorId}.bin`);
  }

  function bump(connectorId) {
    generations.set(connectorId, (generations.get(connectorId) || 0) + 1);
  }

  function persist(connectorId, credential) {
    const file = fileFor(connectorId);
    fsImpl.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // mkdir's mode only applies when it creates the directory.
    if (process.platform !== "win32") fsImpl.chmodSync(dir, 0o700);
    const text = JSON.stringify(credential);
    const data = secretCrypto.isAvailable()
      ? secretCrypto.encrypt(text)
      : Buffer.from(text, "utf8");
    // Write then rename: a crash mid-write must never leave a truncated file,
    // which would read as "not connected" and lose the login.
    const temp = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    try {
      fsImpl.writeFileSync(temp, data, { mode: 0o600 });
      fsImpl.renameSync(temp, file);
    } catch (error) {
      try {
        fsImpl.unlinkSync(temp);
      } catch {
        // The temp file was never created.
      }
      throw error;
    }
  }

  function read(connectorId) {
    const file = fileFor(connectorId);
    if (!fsImpl.existsSync(file)) return null;
    try {
      const buf = fsImpl.readFileSync(file);
      if (!secretCrypto.isAvailable()) return JSON.parse(buf.toString("utf8"));
      const { value, needsReencrypt } = secretCrypto.decrypt(buf);
      const credential = JSON.parse(value);
      if (needsReencrypt) persist(connectorId, credential);
      return credential;
    } catch (error) {
      logger.warn(
        "connector credential unreadable",
        { connectorId, ...describeError(error) },
        "connectors"
      );
      return null;
    }
  }

  // A new login: pending approvals prepared under the old one must not send.
  function replace(connectorId, credential) {
    persist(connectorId, credential);
    bump(connectorId);
  }

  // A token refresh for the same login keeps pending approvals valid.
  function save(connectorId, credential) {
    persist(connectorId, credential);
  }

  function clear(connectorId) {
    const file = fileFor(connectorId);
    if (fsImpl.existsSync(file)) fsImpl.unlinkSync(file);
    bump(connectorId);
  }

  function getGeneration(connectorId) {
    return generations.get(connectorId) || 0;
  }

  return { read, replace, save, clear, getGeneration };
}

module.exports = { createCredentialStore };
