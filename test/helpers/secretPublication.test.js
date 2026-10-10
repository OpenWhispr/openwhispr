const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { BYOK_API_KEYS, SECRET_STORE_KEYS_BY_ENV } = require("../../src/config/secretKeys");

function load() {
  const metadata = [],
    pending = [];
  const process = { env: {}, resourcesPath: "/fake" };
  let publicationFails = false;
  const context = {
    module: { exports: {} },
    process,
    require: (id) => {
      if (id === "electron") return { app: { getPath: () => "/fake" } };
      if (id === "fs") return { existsSync: () => false };
      if (id === "fs/promises") return {};
      if (id === "./debugLogger") return { error() {}, warn() {} };
      if (id === "./i18nMain") return { normalizeUiLanguage: (value) => value };
      if (id === "./secretCrypto") return { isAvailable: () => true };
      if (id === "../config/secretKeys") return { BYOK_API_KEYS, SECRET_STORE_KEYS_BY_ENV };
      if (id === "./windowBroadcast")
        return {
          broadcastToWindows: (channel, data) => {
            metadata.push({ channel, data });
            if (publicationFails) throw new Error("fake destroyed window");
          },
        };
      return require(id);
    },
    __dirname: "/fake",
  };
  vm.runInNewContext(
    fs.readFileSync(require.resolve("../../src/helpers/environment.js"), "utf8"),
    context
  );
  const manager = new context.module.exports();
  manager._saveSecretKey = (name, value) =>
    new Promise((resolve, reject) => pending.push({ name, value, resolve, reject }));
  return { manager, metadata, pending, process, failPublication: () => (publicationFails = true) };
}

test("main publishes only metadata, serializes same-key persistence and never restores queued old memory", async () => {
  const h = load();
  const first = h.manager.saveOpenAIKey("fake-first");
  const second = h.manager.saveOpenAIKey("fake-second");
  const other = h.manager.saveAnthropicKey("fake-independent");
  assert.equal(h.manager.getOpenAIKey(), "fake-second", "accepted memory is immediate");
  const publications = h.metadata.length;
  assert.equal((await h.manager.saveOpenAIKey({ invalid: true })).code, "INVALID_SECRET");
  assert.equal(h.manager.getOpenAIKey(), "fake-second", "invalid IPC input cannot change memory");
  assert.equal(h.metadata.length, publications, "invalid IPC input cannot publish metadata");
  assert.equal(JSON.stringify(h.metadata).includes("fake-first"), false);
  assert.equal(JSON.stringify(h.metadata).includes("fake-second"), false);
  assert.equal(h.metadata[0].data.key, "openaiApiKey");
  assert.equal(h.metadata[1].data.version, 2);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(h.pending.length, 2, "another provider is not locked behind OpenAI");
  const openai = h.pending.find((p) => p.name === "OPENAI_API_KEY");
  const anthropic = h.pending.find((p) => p.name === "ANTHROPIC_API_KEY");
  openai.resolve();
  anthropic.resolve();
  await first;
  await other;
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(h.pending.at(-1).value, "fake-second");
  assert.equal(h.manager.getOpenAIKey(), "fake-second");
  h.pending.at(-1).resolve();
  await second;
  const clear = h.manager.saveOpenAIKey("");
  assert.equal(h.manager.getOpenAIKey(), "");
  await Promise.resolve();
  await Promise.resolve();
  h.pending.at(-1).resolve();
  await clear;
  assert.equal(h.process.env.OPENAI_API_KEY, undefined);
  assert.equal(h.pending.length, 4, "invalid IPC input never queued a secret write");
});

test("publication/disk failures are truthful and do not block newer saves", async () => {
  const h = load();
  h.failPublication();
  const failed = h.manager.saveOpenAIKey("fake-session-only");
  await Promise.resolve();
  await Promise.resolve();
  h.pending[0].reject(new Error("fake disk failure"));
  assert.equal((await failed).code, "SECRET_PERSIST_FAILED");
  assert.equal(h.manager.getOpenAIKey(), "fake-session-only");
  const recovered = h.manager.saveOpenAIKey("fake-recovery");
  await Promise.resolve();
  await Promise.resolve();
  h.pending[1].resolve();
  assert.equal((await recovered).success, true);
  assert.equal(h.manager.getOpenAIKey(), "fake-recovery");
});
