const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

// MOTION_TIMING.copyCrossfadeMs is the single source of truth for the revert
// duration — loaded the same way test/utils/springEasing.test.js loads it
// (a plain dynamic import; the file has no JSX/browser globals so it needs
// neither vite nor a DOM). Asserting against a re-typed "320" here would
// silently go stale the moment the constant is retuned — the exact drift
// CLAUDE.md's task brief calls out from two earlier tasks.
const loadMotionTiming = async () => {
  const { MOTION_TIMING } = await import("../../src/utils/springEasing.ts");
  return MOTION_TIMING;
};

async function mountHook(t, cachePrefix) {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  installBrowserGlobals(t, { window: { electronAPI: {} } });
  const container = installHookDom(t);
  const vite = await createRendererServer(t, { cachePrefix });
  const { useCrossfadedLabel } = await vite.ssrLoadModule("/hooks/useCrossfadedLabel.ts");

  let active = false;
  let revertMs = 0;
  let result;
  function Harness() {
    result = useCrossfadedLabel(active, revertMs);
    return null;
  }
  root = createRoot(container);
  const render = async (nextActive, nextRevertMs) => {
    active = nextActive;
    revertMs = nextRevertMs;
    await React.act(async () => root.render(React.createElement(Harness)));
  };
  return { render, read: () => result };
}

test("the active label appears at once and fades for revertMs before reverting", async (t) => {
  const revertMs = await loadMotionTiming().then((m) => m.copyCrossfadeMs);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { render, read } = await mountHook(t, "openwhispr-crossfaded-label-test-");

  await render(false, revertMs);
  assert.deepEqual(read(), { showActive: false, fading: false });
  await render(true, revertMs);
  assert.deepEqual(read(), { showActive: true, fading: false });
  await render(false, revertMs);
  assert.deepEqual(read(), { showActive: true, fading: true });
  await React.act(async () => {
    t.mock.timers.tick(revertMs);
  });
  assert.deepEqual(read(), { showActive: false, fading: false });
});

// Real shape #2: a second copy click (or any other re-activation) landing
// DURING the revertMs fade window. The hook's own comment flags this as the
// reason showActive is read via closure instead of tracked as a dependency
// ("a revert must not re-arm itself") — that guard is exactly what a stale
// pending timeout would violate, so it earns its own case rather than riding
// along on the happy path above.
test("re-activating during the fade window cancels the pending revert instead of letting it fire late", async (t) => {
  const revertMs = await loadMotionTiming().then((m) => m.copyCrossfadeMs);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { render, read } = await mountHook(t, "openwhispr-crossfaded-label-reactivate-test-");

  await render(true, revertMs);
  await render(false, revertMs);
  assert.deepEqual(read(), { showActive: true, fading: true });

  // Re-copy before the fade timer elapses.
  await render(true, revertMs);
  assert.deepEqual(
    read(),
    { showActive: true, fading: false },
    "re-activating mid-fade must snap straight back to fully shown"
  );

  // If the first revert's setTimeout was not actually cleared, it would
  // still be scheduled to fire here and would incorrectly flip showActive
  // back to false even though `active` is true again.
  await React.act(async () => {
    t.mock.timers.tick(revertMs);
  });
  assert.deepEqual(
    read(),
    { showActive: true, fading: false },
    "the stale timer from the interrupted revert must not fire later"
  );
});
