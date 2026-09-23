const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const load = () => import("../../../src/helpers/connectors/credentialStore.js");

const fakeCrypto = {
  isAvailable: () => true,
  encrypt: (text) => Buffer.from(`enc:${Buffer.from(text).toString("base64")}`),
  decrypt: (buf) => ({
    value: Buffer.from(buf.toString().slice(4), "base64").toString("utf8"),
    needsReencrypt: false,
  }),
};
const silentLogger = { info() {}, warn() {}, error() {} };

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-credentials-"));
}

test("a credential round-trips and is never stored in plaintext", async () => {
  const { createCredentialStore } = await load();
  const dir = tempDir();
  const store = createCredentialStore({ dir, secretCrypto: fakeCrypto, logger: silentLogger });

  store.replace("slack", { accessToken: "xoxp-secret-token", accountId: "U1" });

  assert.deepEqual(store.read("slack"), { accessToken: "xoxp-secret-token", accountId: "U1" });
  const onDisk = fs.readFileSync(path.join(dir, "slack.bin"), "utf8");
  assert.doesNotMatch(onDisk, /xoxp-secret-token/);
});

test("replace and clear bump the generation; save does not", async () => {
  const { createCredentialStore } = await load();
  const store = createCredentialStore({ dir: tempDir(), secretCrypto: fakeCrypto, logger: silentLogger });
  assert.equal(store.getGeneration("slack"), 0);

  store.replace("slack", { accessToken: "a" });
  assert.equal(store.getGeneration("slack"), 1);

  store.save("slack", { accessToken: "refreshed" });
  assert.equal(store.getGeneration("slack"), 1);
  assert.equal(store.read("slack").accessToken, "refreshed");

  store.clear("slack");
  assert.equal(store.getGeneration("slack"), 2);
  assert.equal(store.read("slack"), null);
  assert.equal(store.getGeneration("linear"), 0);
});

test("without an encryption backend the credential falls back to plaintext", async () => {
  const { createCredentialStore } = await load();
  const dir = tempDir();
  const store = createCredentialStore({
    dir,
    secretCrypto: { ...fakeCrypto, isAvailable: () => false },
    logger: silentLogger,
  });
  store.replace("linear", { accessToken: "lin" });
  assert.deepEqual(store.read("linear"), { accessToken: "lin" });
});

test("an unreadable credential reads as disconnected", async () => {
  const { createCredentialStore } = await load();
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, "github.bin"), "garbage");
  const store = createCredentialStore({
    dir,
    secretCrypto: { ...fakeCrypto, decrypt: () => { throw new Error("bad blob"); } },
    logger: silentLogger,
  });
  assert.equal(store.read("github"), null);
});

test("connector ids that could escape the directory are rejected", async () => {
  const { createCredentialStore } = await load();
  const store = createCredentialStore({ dir: tempDir(), secretCrypto: fakeCrypto, logger: silentLogger });
  assert.throws(() => store.replace("../evil", {}), /Invalid connector id/);
});
