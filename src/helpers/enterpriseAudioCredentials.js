const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");

const digest = (value) => createHash("sha256").update(value).digest("hex");
const secureStorageUnavailable = () =>
  Object.assign(new Error("OS-protected enterprise credential storage is unavailable"), {
    code: "SECURE_STORAGE_UNAVAILABLE",
    messageKey: "enterprise.audio.checks.secureStorageUnavailable",
  });

function createEnterpriseAudioCredentials({ directory, crypto, onChanged = () => {} }) {
  const encryption = crypto ?? require("./secretCrypto");
  let generation = 0;
  let writes = Promise.resolve();
  const validateBinding = (...values) => {
    if (
      !values.every((value) => typeof value === "string" && value.length > 0 && value.length <= 256)
    )
      throw new Error("Invalid enterprise credential binding");
  };
  // The account prefix lets account deletion find every workspace's vault.
  const storePath = (accountId, workspaceId) => {
    validateBinding(accountId, workspaceId);
    return path.join(
      directory,
      `${digest(accountId)}.${digest(JSON.stringify([accountId, workspaceId]))}.enc`
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
      throw secureStorageUnavailable();
    try {
      return JSON.parse(
        encryption.decrypt(await fs.readFile(storePath(accountId, workspaceId))).value
      );
    } catch (error) {
      if (error.code === "ENOENT") return {};
      throw error;
    }
  }
  function enqueue(write) {
    const operation = writes
      .catch(() => {})
      .then(async () => {
        await write();
        generation++;
        onChanged();
      });
    writes = operation;
    return operation;
  }
  function update(accountId, workspaceId, change) {
    return enqueue(async () => {
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
    });
  }
  function removeAccount(accountId) {
    validateBinding(accountId);
    const prefix = `${digest(accountId)}.`;
    return enqueue(async () => {
      const names = await fs.readdir(directory).catch((error) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
      // Vaults named before the account prefix can't be attributed to an
      // account; that format never shipped, so none may outlive a deletion.
      const owned = names.filter(
        (name) => name.startsWith(prefix) || /^[a-f0-9]{64}\.enc$/.test(name)
      );
      await Promise.all(owned.map((name) => fs.rm(path.join(directory, name), { force: true })));
    });
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
    } catch (error) {
      if (error.code === "SECURE_STORAGE_UNAVAILABLE") throw error;
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
    } catch (error) {
      if (error.code === "SECURE_STORAGE_UNAVAILABLE") throw error;
      return { present: false, generation };
    }
  }
  return {
    save: (accountId, workspaceId, slot, secret) =>
      saveMany(accountId, workspaceId, { [slot]: secret }),
    saveMany,
    read,
    remove,
    removeAccount,
    status,
    get generation() {
      return generation;
    },
  };
}

module.exports = { createEnterpriseAudioCredentials };
