const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const {
  createTitaniumConnectorBindings,
  watchTitaniumAccount,
} = require("../../../src/helpers/connectors/titaniumConnectorPolicy");

const loadIpc = () => import("../../../src/helpers/connectors/connectorIpc.js");
const loadManager = () => import("../../../src/helpers/connectors/connectorManager.js");
const loadPending = () => import("../../../src/helpers/connectors/pendingActions.js");
const loadCredentials = () => import("../../../src/helpers/connectors/connectorCredentials.js");
const loadStore = () => import("../../../src/helpers/connectors/credentialStore.js");

const silentLogger = { info() {}, warn() {}, error() {} };
const fakeCrypto = {
  isAvailable: () => true,
  encrypt: (text) => Buffer.from(`enc:${Buffer.from(text).toString("base64")}`),
  decrypt: (buf) => ({
    value: Buffer.from(buf.toString().slice(4), "base64").toString("utf8"),
    needsReencrypt: false,
  }),
};

// The shape of TitaniumSession the fork wiring depends on.
function fakeSession(initial) {
  const session = new EventEmitter();
  session.current = initial;
  session.getState = () => ({
    signedIn: session.current.signedIn,
    accountBound: Boolean(session.current.accountId),
    licensed: session.current.licensed,
  });
  session.getAccountScope = () =>
    session.current.accountId ? { accountId: session.current.accountId, authGeneration: 1 } : null;
  session.set = (next) => {
    session.current = { ...session.current, ...next };
    session.emit("changed", session.getState());
  };
  return session;
}

async function setup(initial) {
  const [{ registerConnectorIpc }, { createConnectorManager }, { createPendingActions }] =
    await Promise.all([loadIpc(), loadManager(), loadPending()]);
  const [{ createConnectorCredentials }, { createCredentialStore }] = await Promise.all([
    loadCredentials(),
    loadStore(),
  ]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tw-titanium-connectors-"));
  const session = fakeSession(initial);
  const bindings = createTitaniumConnectorBindings(() => session);
  const credentials = createConnectorCredentials({
    store: createCredentialStore({ dir, secretCrypto: fakeCrypto, logger: silentLogger }),
    getAccountId: () => bindings.getAccountScope()?.accountId ?? null,
  });

  const connector = {
    id: "fake",
    actions: { post: { kind: "approval", editable: { body: "text" } } },
    async getStatus() {
      return { connected: Boolean(credentials.read(credentials.activeAccountId(), "fake")) };
    },
    async getBinding() {
      const read = credentials.read(credentials.activeAccountId(), "fake");
      return read ? { accountId: "U1", workspaceId: "T1", generation: read.generation } : null;
    },
    async prepare(action, args) {
      return {
        status: "ready",
        payload: { text: args.text },
        preview: { verbKey: "default", destinationLabel: "#eng", accountLabel: "x", body: "hi" },
      };
    },
    async commit() {
      return { state: "sent" };
    },
  };
  const rows = new Map();
  const manager = createConnectorManager({
    connectors: [connector],
    pendingActions: createPendingActions(),
    actionLog: {
      reconcileInterrupted: () => ({ unknown: 0, cancelled: 0 }),
      insert: (row) => rows.set(row.id, { ...row }),
      update: () => 1,
      listRecent: () => [],
    },
    logger: silentLogger,
    getAccountId: () => bindings.getAccountScope()?.accountId ?? null,
    credentials,
  });
  const handlers = new Map();
  registerConnectorIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    manager,
    getPolicyState: bindings.getPolicyState,
    getAccountScope: bindings.getAccountScope,
  });
  return { session, manager, handlers, credentials, dir };
}

const prepare = (handlers) => handlers.get("connector-prepare")({}, "fake", "post", { text: "hi" });

test("a licensed, bound Titanium session reaches a connector call at its account's slot", async () => {
  const { session, handlers, credentials, dir } = await setup({
    signedIn: true,
    accountId: "acc_1",
    licensed: true,
  });
  credentials.replace("acc_1", "fake", { accessToken: "t" }, 0);
  const slot = `fake-${crypto.createHash("sha256").update("acc_1").digest("hex").slice(0, 24)}`;
  assert.deepEqual(fs.readdirSync(dir), [`${slot}.bin`], "slot keyed on the Titanium account id");

  const result = await prepare(handlers);
  assert.equal(result.status, "ready");

  // Another Titanium account never sees acc_1's login.
  session.set({ accountId: "acc_2" });
  assert.equal(credentials.read("acc_2", "fake"), null);
  const other = await prepare(handlers);
  assert.deepEqual(other, { status: "unavailable", reason: "not_connected" });
});

test("each missing precondition is refused with its own code", async () => {
  const cases = [
    [{ signedIn: false, accountId: null, licensed: false }, "signed_out"],
    [{ signedIn: true, accountId: null, licensed: true }, "reauth_required"],
    [{ signedIn: true, accountId: "acc_1", licensed: false }, "plan_required"],
  ];
  for (const [initial, reason] of cases) {
    const { handlers } = await setup(initial);
    assert.deepEqual(await prepare(handlers), { status: "unavailable", reason }, reason);
  }
});

test("sign-out and an account switch each reset connector state once; a license change never does", async () => {
  const { session, manager } = await setup({ signedIn: true, accountId: "acc_a", licensed: true });
  let resets = 0;
  const original = manager.accountChanged;
  manager.accountChanged = () => {
    resets += 1;
    return original();
  };
  watchTitaniumAccount(session, () => manager.accountChanged());

  session.set({ licensed: false });
  assert.equal(resets, 0, "license-only change");
  session.set({ accountId: "acc_b" });
  assert.equal(resets, 1, "account switch");
  session.set({ signedIn: false, accountId: null });
  assert.equal(resets, 2, "sign-out");
});
