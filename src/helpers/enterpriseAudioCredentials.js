const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");

function createEnterpriseAudioCredentials({ directory, crypto, onChanged = () => {} }) {
  const encryption = crypto ?? require("./secretCrypto");
  let generation = 0;
  let writes = Promise.resolve();
  const storePath = (accountId, workspaceId) => {
    if (
      ![accountId, workspaceId].every(
        (value) => typeof value === "string" && value.length > 0 && value.length <= 256
      )
    )
      throw new Error("Invalid enterprise credential binding");
    return path.join(
      directory,
      `${createHash("sha256")
        .update(JSON.stringify([accountId, workspaceId]))
        .digest("hex")}.enc`
    );
  };
  const validateSlot = (slot) => {
    if (typeof slot !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(slot))
      throw new Error("Invalid enterprise credential slot");
  };
  async function load(accountId, workspaceId) {
    if (
      !crypto &&
      process.platform === "linux" &&
      require("electron").safeStorage.getSelectedStorageBackend() === "basic_text"
    )
      throw new Error("OS-protected enterprise credential storage is unavailable");
    try {
      return JSON.parse(
        encryption.decrypt(await fs.readFile(storePath(accountId, workspaceId))).value
      );
    } catch (error) {
      if (error.code === "ENOENT") return {};
      throw error;
    }
  }
  function update(accountId, workspaceId, change) {
    const operation = writes
      .catch(() => {})
      .then(async () => {
        const values = await load(accountId, workspaceId);
        change(values);
        const target = storePath(accountId, workspaceId);
        await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        const temporary = `${target}.${randomUUID()}.tmp`;
        try {
          await fs.writeFile(temporary, encryption.encrypt(JSON.stringify(values)), {
            mode: 0o600,
            flag: "wx",
          });
          await fs.rename(temporary, target);
        } finally {
          await fs.rm(temporary, { force: true });
        }
        generation++;
        onChanged();
      });
    writes = operation;
    return operation;
  }
  async function saveMany(accountId, workspaceId, entries) {
    if (
      !entries ||
      typeof entries !== "object" ||
      Array.isArray(entries) ||
      Object.keys(entries).length > 20
    )
      throw new Error("Invalid enterprise credential bundle");
    for (const [slot, secret] of Object.entries(entries)) {
      validateSlot(slot);
      if (
        typeof secret !== "string" ||
        !secret.trim() ||
        secret.length > 16384 ||
        /[\r\n]/.test(secret)
      )
        throw new Error("Invalid enterprise credential");
    }
    return update(accountId, workspaceId, (values) => Object.assign(values, entries));
  }
  async function read(accountId, workspaceId, slot) {
    validateSlot(slot);
    try {
      const values = await load(accountId, workspaceId);
      if (typeof values[slot] !== "string" || !values[slot]) throw new Error();
      return values[slot];
    } catch {
      throw Object.assign(new Error("Provision the enterprise credential on this device"), {
        code: "CREDENTIAL_MISSING",
        messageKey: "enterprise.audio.credentialMissing",
      });
    }
  }
  async function remove(accountId, workspaceId, slot) {
    validateSlot(slot);
    return update(accountId, workspaceId, (values) => {
      delete values[slot];
    });
  }
  async function status(accountId, workspaceId, slot) {
    try {
      await read(accountId, workspaceId, slot);
      return { present: true, generation };
    } catch {
      return { present: false, generation };
    }
  }
  return {
    save: (accountId, workspaceId, slot, secret) =>
      saveMany(accountId, workspaceId, { [slot]: secret }),
    saveMany,
    read,
    remove,
    status,
    get generation() {
      return generation;
    },
  };
}

module.exports = { createEnterpriseAudioCredentials };
