const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const SLACK = {
  id: "slack",
  connected: true,
  accountLabel: "chad",
  workspaceLabel: "Acme",
  needsReconnect: false,
};

async function loadStore(t, electronAPI) {
  installBrowserGlobals(t, { window: { electronAPI } });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-connector-status-store-test-",
  });
  return vite.ssrLoadModule("/stores/connectorStatusStore.ts");
}

test("status loads once, follows broadcasts, and a pending reconnect is not ready", async (t) => {
  let listener = null;
  let loads = 0;
  const store = await loadStore(t, {
    connectorStatus: async () => {
      loads += 1;
      return [SLACK];
    },
    onConnectorStatusChanged: (callback) => {
      listener = callback;
      return () => {};
    },
  });

  await store.ensureConnectorStatus();
  await store.ensureConnectorStatus();
  assert.equal(loads, 1);
  assert.equal(store.isConnectorReady("slack"), true);

  listener([{ ...SLACK, needsReconnect: true }]);
  assert.equal(store.isConnectorReady("slack"), false);

  listener([
    {
      id: "email",
      connected: true,
      accountLabel: null,
      workspaceLabel: null,
      needsReconnect: false,
    },
  ]);
  assert.equal(store.isConnectorReady("slack"), false);
  assert.equal(store.isConnectorReady("email"), true);
});

test("an older status response never overwrites a newer broadcast", async (t) => {
  let listener = null;
  let answerLoad;
  const store = await loadStore(t, {
    connectorStatus: () =>
      new Promise((resolve) => {
        answerLoad = resolve;
      }),
    onConnectorStatusChanged: (callback) => {
      listener = callback;
      return () => {};
    },
  });

  const loading = store.ensureConnectorStatus();
  listener([{ ...SLACK, connected: false }]); // Disconnect announced while the load is in flight
  answerLoad([SLACK]); // the load's older snapshot, still connected
  await loading;

  assert.equal(store.isConnectorReady("slack"), false);
});

test("a failed load leaves connectors off and is retried by the next ensure", async (t) => {
  let attempts = 0;
  const store = await loadStore(t, {
    connectorStatus: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("ipc down");
      return [SLACK];
    },
    onConnectorStatusChanged: () => () => {},
  });

  await store.ensureConnectorStatus();
  assert.equal(store.isConnectorReady("slack"), false);
  assert.equal(store.useConnectorStatusStore.getState().loaded, false);

  await store.ensureConnectorStatus();
  assert.equal(store.isConnectorReady("slack"), true);
  assert.equal(attempts, 2);
});
