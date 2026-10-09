const fs = require("fs/promises");
const path = require("path");
const { randomUUID } = require("crypto");
const modelData = require("../models/modelRegistryData.json");

const PROVIDERS = new Set(
  [...modelData.cloudProviders, ...modelData.transcriptionProviders]
    .map((entry) => entry.id)
    .concat("openrouter")
);
const MAX_KEYS = 30;

/** Additional provider keys use the same encryption backend as the default key slots. */
class FallbackKeyStore {
  constructor({ directory, crypto }) {
    this.directory = directory;
    this.file = path.join(directory, "fallback-keys.enc");
    this.crypto = crypto;
    this.writeQueue = Promise.resolve();
  }

  async read() {
    try {
      const { value } = this.crypto.decrypt(await fs.readFile(this.file));
      const data = JSON.parse(value);
      if (
        data.version !== 1 ||
        !Array.isArray(data.keys) ||
        data.keys.length > MAX_KEYS ||
        data.keys.some(
          (profile) =>
            !profile ||
            typeof profile.id !== "string" ||
            !/^[a-zA-Z0-9-]{1,64}$/.test(profile.id) ||
            !PROVIDERS.has(profile.provider) ||
            typeof profile.label !== "string" ||
            !profile.label.trim() ||
            profile.label.length > 80 ||
            typeof profile.key !== "string" ||
            !profile.key.trim() ||
            profile.key.length > 8192
        ) ||
        new Set(data.keys.map((profile) => profile.id)).size !== data.keys.length
      )
        throw new Error("Invalid key store");
      return data.keys;
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw new Error("Could not read saved fallback keys");
    }
  }

  metadata(profile) {
    return { id: profile.id, provider: profile.provider, label: profile.label };
  }

  async list() {
    await this.writeQueue.catch(() => {});
    return (await this.read()).map((profile) => this.metadata(profile));
  }

  async getKey(id, provider) {
    if (typeof id !== "string" || !PROVIDERS.has(provider)) return null;
    await this.writeQueue.catch(() => {});
    return (
      (await this.read()).find((profile) => profile.id === id && profile.provider === provider)
        ?.key ?? null
    );
  }

  mutate(fn) {
    const operation = this.writeQueue
      .catch(() => {})
      .then(async () => {
        if (!this.crypto.isAvailable()) throw new Error("Secure key storage is unavailable");
        const keys = await this.read();
        const result = fn(keys);
        const encrypted = this.crypto.encrypt(JSON.stringify({ version: 1, keys }));
        await fs.mkdir(this.directory, { recursive: true });
        const temporary = `${this.file}.tmp`;
        await fs.writeFile(temporary, encrypted, { mode: 0o600 });
        await fs.rename(temporary, this.file);
        return result;
      });
    this.writeQueue = operation;
    return operation;
  }

  save({ provider, label, key } = {}) {
    if (
      !PROVIDERS.has(provider) ||
      typeof label !== "string" ||
      !label.trim() ||
      label.trim().length > 80 ||
      typeof key !== "string" ||
      !key.trim() ||
      key.length > 8192
    ) {
      return Promise.reject(new Error("Enter a provider, name and API key"));
    }
    return this.mutate((keys) => {
      if (keys.length >= MAX_KEYS) throw new Error("Too many saved fallback keys");
      const profile = { id: randomUUID(), provider, label: label.trim(), key: key.trim() };
      keys.push(profile);
      return this.metadata(profile);
    });
  }

  remove(id) {
    if (typeof id !== "string") return Promise.reject(new Error("Invalid key profile"));
    return this.mutate((keys) => {
      const index = keys.findIndex((profile) => profile.id === id);
      if (index >= 0) keys.splice(index, 1);
    });
  }
}

module.exports = { FallbackKeyStore };
