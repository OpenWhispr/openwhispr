const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

// Drives the hook the way the pill window does: main reports hotkey presses
// over start-dictation (hold, latch) and toggle-dictation (a Tap-mode slot).
// The store is seeded through storage; the marker keeps the module-scope
// migration from rewriting the seed.
async function mountHook(t, { initialStorage, cachePrefix }) {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  const listeners = {};
  const { storage } = installBrowserGlobals(t, {
    initialStorage: { activationModeHoldMigration: "done", ...initialStorage },
    window: {
      electronAPI: {
        onStartDictation: (callback) => {
          listeners.start = callback;
          return () => {};
        },
        onToggleDictation: (callback) => {
          listeners.toggle = callback;
          return () => {};
        },
      },
    },
  });
  const container = installHookDom(t);
  const vite = await createRendererServer(t, { cachePrefix });
  const { useHoldMigrationCard } = await vite.ssrLoadModule("/hooks/useHoldMigrationCard.js");

  let result;
  function Harness() {
    result = useHoldMigrationCard();
    return null;
  }
  root = createRoot(container);
  await React.act(async () => {
    root.render(React.createElement(Harness));
  });
  const press = async (channel = "start") => {
    await React.act(async () => {
      listeners[channel]?.({ inputKind: "dictation" });
    });
  };
  return { storage, press, read: () => result };
}

test("the first hotkey press after a migration shows the card once; the next press dismisses it", async (t) => {
  const { storage, press, read } = await mountHook(t, {
    cachePrefix: "openwhispr-hold-migration-hook-first-press-",
    initialStorage: { holdMigrationCardPending: "true", activationMode: "push" },
  });

  assert.equal(read().visible, false);
  await press("start");
  assert.equal(read().visible, true);
  assert.equal(storage.getItem("holdMigrationCardShown"), "true");

  await press("start");
  assert.equal(read().visible, false);
});

test("the X dismisses the card", async (t) => {
  const { press, read } = await mountHook(t, {
    cachePrefix: "openwhispr-hold-migration-hook-dismiss-",
    initialStorage: { holdMigrationCardPending: "true", activationMode: "push" },
  });
  await press("toggle");
  assert.equal(read().visible, true);
  await React.act(async () => read().dismiss());
  assert.equal(read().visible, false);
});

// Each case gets its own test (rather than looping inside one) so its
// mountHook's globals/DOM stubs and deferred root.unmount() are torn down by
// t.after before the next case installs a fresh set — installBrowserGlobals
// and installHookDom mutate shared globalThis state, so interleaving three
// live mounts under one test's deferred cleanup unmounts a later root after
// an earlier case has already deleted the fake document/rAF it needs.
const neverShowsCases = [
  ["a card already shown", { holdMigrationCardPending: "true", holdMigrationCardShown: "true", activationMode: "push" }],
  ["a fresh install", { holdMigrationCardPending: "false", activationMode: "push" }],
  ["a demoted dictation slot", { holdMigrationCardPending: "true", activationMode: "tap" }],
];

for (const [label, initialStorage] of neverShowsCases) {
  test(`${label} never shows the card`, async (t) => {
    const { press, read } = await mountHook(t, {
      cachePrefix: `openwhispr-hold-migration-hook-${label.replace(/\s+/g, "-")}-`,
      initialStorage,
    });
    await press("start");
    assert.equal(read().visible, false);
  });
}
