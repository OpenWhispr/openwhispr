const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createTokenStore } = require("../../src/helpers/llmCli/llmCliTokenStore");

const TOKEN = `sk-ant-oat01-${"Z".repeat(110)}`;

// Reversible stand-in for safeStorage: the ciphertext does not contain the plaintext.
function fakeSafeStorage(available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (text) => Buffer.from(`ENC:${Buffer.from(text).reverse().toString("base64")}`),
    decryptString: (buf) => {
      const raw = buf.toString();
      if (!raw.startsWith("ENC:")) throw new Error("bad ciphertext");
      return Buffer.from(raw.slice(4), "base64").reverse().toString();
    },
  };
}

function makeStore(available = true) {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "llm-cli-token-")), "secure-keys");
  return { dir, store: createTokenStore({ safeStorage: fakeSafeStorage(available), dir }) };
}

test("save encrypts, load round-trips, the file never holds the plaintext", () => {
  const { store } = makeStore();
  assert.equal(store.has(), false);
  assert.equal(store.load(), null);
  store.save(TOKEN);
  assert.equal(store.has(), true);
  assert.equal(store.load(), TOKEN);
  assert.ok(!fs.readFileSync(store.file).toString("latin1").includes(TOKEN));
  assert.ok(!fs.readFileSync(store.file).toString("latin1").includes("sk-ant"));
  assert.equal(path.basename(store.file), "llm-cli-claude-oauth.bin");
});

test("clear deletes the file", () => {
  const { store } = makeStore();
  store.save(TOKEN);
  store.clear();
  assert.equal(store.has(), false);
  assert.equal(store.load(), null);
  store.clear(); // idempotent
});

test("with encryption unavailable save throws encryption-unavailable and writes nothing", () => {
  const { store, dir } = makeStore(false);
  assert.throws(() => store.save(TOKEN), { code: "encryption-unavailable" });
  assert.equal(fs.existsSync(dir), false);
  assert.equal(store.has(), false);
});

test("save rejects an empty token and load returns null for a corrupted file", () => {
  const { store } = makeStore();
  assert.throws(() => store.save(""), { code: "invalid-input" });
  store.save(TOKEN);
  fs.writeFileSync(store.file, "garbage");
  assert.equal(store.load(), null);
});
