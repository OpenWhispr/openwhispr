const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { FallbackKeyStore } = require("../../src/helpers/fallbackKeys");

test("key profiles are encrypted, survive reload and never expose keys in metadata", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "fallback-key-store-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const master = crypto.randomBytes(32);
  const encryption = {
    isAvailable: () => true,
    encrypt: (value) => {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", master, iv);
      return Buffer.concat([iv, cipher.update(value), cipher.final(), cipher.getAuthTag()]);
    },
    decrypt: (buffer) => {
      const decipher = crypto.createDecipheriv("aes-256-gcm", master, buffer.subarray(0, 12));
      decipher.setAuthTag(buffer.subarray(-16));
      return {
        value: Buffer.concat([
          decipher.update(buffer.subarray(12, -16)),
          decipher.final(),
        ]).toString(),
      };
    },
  };
  const store = new FallbackKeyStore({ directory, crypto: encryption });
  const [one, two] = await Promise.all([
    store.save({ provider: "openrouter", label: "Personal", key: "test-secret-one" }),
    store.save({ provider: "groq", label: "Backup", key: "test-secret-two" }),
  ]);
  assert.deepEqual(Object.keys(one).sort(), ["id", "label", "provider"]);
  const disk = await fs.readFile(path.join(directory, "fallback-keys.enc"));
  assert.equal(disk.includes(Buffer.from("test-secret")), false);
  const reopened = new FallbackKeyStore({ directory, crypto: encryption });
  assert.equal((await reopened.list()).length, 2);
  assert.equal(await reopened.getKey(one.id, "openrouter"), "test-secret-one");
  assert.equal(await reopened.getKey(one.id, "groq"), null);
  await reopened.remove(one.id);
  assert.equal(await reopened.getKey(one.id, "openrouter"), null);
  assert.equal(await reopened.getKey(two.id, "groq"), "test-secret-two");
  await assert.rejects(store.save({ provider: "../../escape", label: "bad", key: "key" }));
  const corrupt = encryption.encrypt(
    JSON.stringify({ version: 1, keys: [{ id: "bad", provider: "groq", label: "Invalid" }] })
  );
  await fs.writeFile(store.file, corrupt);
  await assert.rejects(store.list(), /Could not read saved fallback keys/);
  await assert.rejects(
    store.save({ provider: "groq", label: "New", key: "new-secret" }),
    /Could not read saved fallback keys/
  );
  assert.deepEqual(await fs.readFile(store.file), corrupt);
});

test("unavailable encryption never writes plaintext keys", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "fallback-key-unavailable-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new FallbackKeyStore({ directory, crypto: { isAvailable: () => false } });
  await assert.rejects(
    store.save({ provider: "groq", label: "Backup", key: "secret" }),
    /Secure key storage/
  );
  assert.deepEqual(await fs.readdir(directory), []);
});
