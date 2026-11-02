const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

test("account changes clear cached history and older loads cannot restore it", async (t) => {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  const accountA = [{ id: 1, text: "A's history" }];
  const accountB = [{ id: 2, text: "B's history" }];
  const pending = [];
  let onScopeChanged;
  let readHistory = async () => accountA;
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        getTranscriptions: (...args) => readHistory(...args),
        onActiveAccountScopeChanged: (callback) => {
          onScopeChanged = callback;
          return () => {};
        },
      },
    },
  });
  const container = installHookDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-transcription-account-scope-test-",
  });
  const store = await vite.ssrLoadModule("/stores/transcriptionStore.ts");
  let visibleHistory;
  function History() {
    visibleHistory = store.useTranscriptions();
    return null;
  }
  root = require("react-dom/client").createRoot(container);
  await React.act(async () => {
    root.render(React.createElement(History));
    await store.initializeTranscriptions(100, true);
  });
  assert.deepEqual(visibleHistory, accountA);

  readHistory = (limit, options) =>
    new Promise((resolve) => pending.push({ resolve, limit, options }));
  const olderLoad = store.initializeTranscriptions();
  await React.act(async () => onScopeChanged(null));
  assert.deepEqual(visibleHistory, [], "sign-out immediately hides the departed history");
  await React.act(async () => onScopeChanged({ accountId: "account-b", authGeneration: 2 }));
  assert.deepEqual(visibleHistory, [], "the new account waits for its own history");
  assert.deepEqual(
    pending.map(({ limit, options }) => [limit, options]),
    Array.from({ length: 3 }, () => [100, { includeDiscarded: true }])
  );

  await React.act(async () => pending[2].resolve(accountB));
  assert.deepEqual(visibleHistory, accountB);
  await React.act(async () => {
    pending[0].resolve(accountA);
    pending[1].resolve(accountA);
    await olderLoad;
  });
  assert.deepEqual(visibleHistory, accountB, "superseded reads cannot expose the old account");
});
