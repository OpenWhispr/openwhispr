const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const load = () => import("../../../src/helpers/connectors/connectorCredentials.js");
const loadStore = () => import("../../../src/helpers/connectors/credentialStore.js");

const fakeCrypto = {
  isAvailable: () => true,
  encrypt: (text) => Buffer.from(`enc:${Buffer.from(text).toString("base64")}`),
  decrypt: (buf) => ({
    value: Buffer.from(buf.toString().slice(4), "base64").toString("utf8"),
    needsReencrypt: false,
  }),
};
const silentLogger = { info() {}, warn() {}, error() {} };

async function setup(initialAccount = "acct-a") {
  const [{ createConnectorCredentials }, { createCredentialStore }] = await Promise.all([
    load(),
    loadStore(),
  ]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-connector-credentials-"));
  let accountId = initialAccount;
  const credentials = createConnectorCredentials({
    store: createCredentialStore({ dir, secretCrypto: fakeCrypto, logger: silentLogger }),
    getAccountId: () => accountId,
  });
  return { credentials, dir, switchTo: (next) => (accountId = next) };
}

const code = (expected) => (error) => error.code === expected;

test("each OpenWhispr account has its own login slot", async () => {
  const { credentials, dir } = await setup();

  credentials.replace("acct-a", "slack", { accessToken: "a" }, 0);
  credentials.replace("acct-b", "slack", { accessToken: "b" }, 0);

  assert.equal(credentials.read("acct-a", "slack").credential.accessToken, "a");
  assert.equal(credentials.read("acct-b", "slack").credential.accessToken, "b");
  const files = fs.readdirSync(dir);
  assert.equal(files.length, 2);
  assert.ok(
    files.every((name) => /^slack-[0-9a-f]{24}\.bin$/.test(name)),
    "account ids never appear in file names"
  );
});

test("a write from a stale generation is refused and changes nothing", async () => {
  const { credentials } = await setup();
  const first = credentials.replace("acct-a", "slack", { accessToken: "a" }, 0);

  assert.throws(
    () => credentials.replace("acct-a", "slack", { accessToken: "x" }, 0),
    code("connection_changed")
  );
  assert.throws(
    () => credentials.save("acct-a", "slack", { accessToken: "x" }, first - 1),
    code("connection_changed")
  );
  assert.equal(credentials.read("acct-a", "slack").credential.accessToken, "a");

  credentials.save("acct-a", "slack", { accessToken: "refreshed" }, first);
  assert.deepEqual(credentials.read("acct-a", "slack"), {
    credential: { accessToken: "refreshed" },
    generation: first,
  });

  credentials.clear("acct-a", "slack", first);
  assert.equal(credentials.read("acct-a", "slack"), null);
  assert.throws(
    () => credentials.save("acct-a", "slack", { accessToken: "late" }, first),
    code("connection_changed")
  );
  assert.equal(credentials.read("acct-a", "slack"), null);
});

test("no account means no login and no writes", async () => {
  const { credentials, switchTo } = await setup();
  switchTo(null);
  assert.equal(credentials.activeAccountId(), null);
  assert.equal(credentials.read(null, "slack"), null);
  assert.throws(
    () => credentials.replace(null, "slack", { accessToken: "a" }, 0),
    code("signed_out")
  );
});
