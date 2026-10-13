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
  const store = createCredentialStore({
    dir: tempDir(),
    secretCrypto: fakeCrypto,
    logger: silentLogger,
  });
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
    secretCrypto: {
      ...fakeCrypto,
      decrypt: () => {
        throw new Error("bad blob");
      },
    },
    logger: silentLogger,
  });
  assert.equal(store.read("github"), null);
});

test("connector ids that could escape the directory are rejected", async () => {
  const { createCredentialStore } = await load();
  const store = createCredentialStore({
    dir: tempDir(),
    secretCrypto: fakeCrypto,
    logger: silentLogger,
  });
  assert.throws(() => store.replace("../evil", {}), /Invalid connector id/);
});

test("writes are atomic and leave no temp files behind", async () => {
  const { createCredentialStore } = await load();
  const dir = tempDir();
  const store = createCredentialStore({ dir, secretCrypto: fakeCrypto, logger: silentLogger });

  store.replace("slack", { accessToken: "a" });
  store.save("slack", { accessToken: "b" });

  assert.deepEqual(fs.readdirSync(dir), ["slack.bin"]);
  assert.equal(store.read("slack").accessToken, "b");
});

test("a failed rename keeps the previous credential and removes the temp file", async () => {
  const { createCredentialStore } = await load();
  const dir = tempDir();
  let failRename = false;
  const fsImpl = {
    ...fs,
    renameSync: (from, to) => {
      if (failRename) throw Object.assign(new Error("rename failed"), { code: "EIO" });
      return fs.renameSync(from, to);
    },
  };
  const store = createCredentialStore({
    dir,
    secretCrypto: fakeCrypto,
    logger: silentLogger,
    fsImpl,
  });
  store.replace("slack", { accessToken: "old" });

  failRename = true;
  assert.throws(
    () => store.save("slack", { accessToken: "new" }),
    (error) => error.code === "EIO"
  );

  assert.equal(store.read("slack").accessToken, "old");
  assert.deepEqual(fs.readdirSync(dir), ["slack.bin"]);
});

test(
  "the credentials directory is private to the user",
  { skip: process.platform === "win32" },
  async () => {
    const { createCredentialStore } = await load();
    const dir = path.join(tempDir(), "connectors");
    fs.mkdirSync(dir, { mode: 0o755 });
    const store = createCredentialStore({ dir, secretCrypto: fakeCrypto, logger: silentLogger });

    store.replace("slack", { accessToken: "a" });

    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(dir, "slack.bin")).mode & 0o777, 0o600);
  }
);

test("an unreadable credential is logged without its error message", async () => {
  const { createCredentialStore } = await load();
  const dir = tempDir();
  const lines = [];
  const logger = { info() {}, error() {}, warn: (...args) => lines.push(args) };
  fs.writeFileSync(path.join(dir, "slack.bin"), "enc:bm90IGpzb24=");
  const store = createCredentialStore({ dir, secretCrypto: fakeCrypto, logger });

  assert.equal(store.read("slack"), null);
  assert.match(JSON.stringify(lines), /SyntaxError/);
  assert.doesNotMatch(JSON.stringify(lines), /not valid JSON|Unexpected token/);
});
