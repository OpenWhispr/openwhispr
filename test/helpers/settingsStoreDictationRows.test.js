const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// The store is the boundary the UI reads. Two things have to survive it: the
// rows main committed (so a rename never moves a mode onto a neighbour), and
// `degraded` — main could not confirm the desktop released or restored the old
// bindings, so the previous rows must NOT be presented as known-good.

test("the dictation row store commits, rolls back and keeps uncertainty visible", async (t) => {
  const calls = [];
  let answer = { success: true };
  const { storage } = installBrowserGlobals(t, {
    window: {
      electronAPI: {
        applyDictationHotkeys: async (request) => {
          calls.push(request);
          return typeof answer === "function" ? answer(request) : answer;
        },
      },
    },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-dictation-rows-test-",
  });
  const load = async (seed) => {
    storage.clear();
    for (const [key, value] of Object.entries(seed)) storage.setItem(key, value);
    vite.moduleGraph.invalidateAll();
    const mod = await vite.ssrLoadModule("/stores/settingsStore.ts");
    return mod.useSettingsStore;
  };

  const committed = [
    { key: "Ctrl+Shift+Space", mode: "cleaned" },
    { key: "Control+Alt+Shift", mode: "raw" },
  ];

  await t.test("a legacy flat key list loads as rows that follow the app setting", async () => {
    const store = await load({ dictationKey: "Control+Super,F8" });
    assert.deepEqual(store.getState().dictationRows, [
      { key: "Control+Super", mode: null },
      { key: "F8", mode: null },
    ]);
  });

  await t.test("a stored row set loads with its modes and spellings", async () => {
    const store = await load({ dictationHotkeyConfig: JSON.stringify(committed) });
    assert.deepEqual(store.getState().dictationRows, committed);
  });

  await t.test("an accepted commit adopts the rows main returns", async () => {
    const store = await load({ dictationHotkeyConfig: JSON.stringify(committed) });
    calls.length = 0;
    const next = [
      { key: "Control+Shift+K", mode: "cleaned" },
      { key: "Control+Alt+Shift", mode: "raw" },
    ];
    answer = { success: true, rows: next };

    const result = await store.getState().applyDictationRows(next);

    assert.equal(result.success, true);
    assert.deepEqual(calls, [{ rows: next }]);
    assert.deepEqual(store.getState().dictationRows, next);
    // The flat list every other reader still uses stays in step.
    assert.equal(store.getState().dictationKey, "Control+Shift+K,Control+Alt+Shift");
    assert.equal(storage.getItem("dictationKey"), "Control+Shift+K,Control+Alt+Shift");
  });

  await t.test("a clean refusal keeps the committed rows and names the error", async () => {
    const store = await load({ dictationHotkeyConfig: JSON.stringify(committed) });
    answer = { success: false, reason: "hold_unsupported_row", error: "Hold needs a regular key" };

    const result = await store
      .getState()
      .applyDictationRows([...committed, { key: "Control+Alt", mode: null }]);

    assert.equal(result.success, false);
    assert.equal(result.reason, "hold_unsupported_row");
    assert.equal(result.error, "Hold needs a regular key");
    assert.notEqual(result.degraded, true, "a rollback main confirmed is not degraded");
    assert.deepEqual(store.getState().dictationRows, committed);
  });

  await t.test("an unconfirmed rollback reaches the UI as degraded", async () => {
    const store = await load({ dictationHotkeyConfig: JSON.stringify(committed) });
    answer = { success: false, reason: "registration_failed", error: "in use", degraded: true };

    const result = await store
      .getState()
      .applyDictationRows([{ key: "Control+Shift+K", mode: "cleaned" }]);

    assert.equal(result.success, false);
    assert.equal(result.degraded, true, "the desktop's state is unknown and the UI must say so");
    // The rows shown are the last ones main committed; `degraded` is what tells
    // the UI not to present them as currently working shortcuts.
    assert.deepEqual(store.getState().dictationRows, committed);
  });

  await t.test("a thrown IPC leaves the committed rows in place", async () => {
    const store = await load({ dictationHotkeyConfig: JSON.stringify(committed) });
    answer = () => {
      throw new Error("IPC channel closed");
    };

    const result = await store.getState().applyDictationRows([{ key: "F9", mode: null }]);

    assert.equal(result.success, false);
    assert.match(result.error, /IPC channel closed/);
    assert.deepEqual(store.getState().dictationRows, committed);
  });
});

test("a successful commit main could not fully confirm keeps its uncertainty", async (t) => {
  const { storage } = installBrowserGlobals(t, {
    window: {
      electronAPI: {
        applyDictationHotkeys: async ({ rows }) => ({ success: true, rows, degraded: true }),
      },
    },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-dictation-rows-degraded-test-",
  });
  storage.clear();
  storage.setItem("dictationHotkeyConfig", JSON.stringify([{ key: "F8", mode: null }]));
  vite.moduleGraph.invalidateAll();
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");

  const next = [{ key: "F9", mode: "cleaned" }];
  const result = await useSettingsStore.getState().applyDictationRows(next);

  assert.equal(result.success, true);
  assert.equal(result.degraded, true, "the UI has to be able to say the old key may still fire");
  // The commit happened, so the new rows are what the UI shows.
  assert.deepEqual(useSettingsStore.getState().dictationRows, next);
});
