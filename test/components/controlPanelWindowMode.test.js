const assert = require("node:assert/strict");
const test = require("node:test");

const load = () => import("../../src/utils/controlPanelWindowMode.ts");

const settledState = {
  isControlPanel: true,
  isLoading: false,
  isWaitingForPolicyStart: false,
  showOnboarding: false,
  needsReauth: false,
};

test("returning-user authentication selects the compact window", async () => {
  const { resolveSettledControlPanelWindowMode } = await load();

  assert.equal(
    resolveSettledControlPanelWindowMode({ ...settledState, needsReauth: true }),
    "compact"
  );
});

test("normal control-panel content restores the saved window", async () => {
  const { resolveSettledControlPanelWindowMode } = await load();

  assert.equal(resolveSettledControlPanelWindowMode(settledState), "restore");
});

test("unsettled and onboarding routes leave window sizing to their owners", async () => {
  const { resolveSettledControlPanelWindowMode } = await load();

  assert.equal(
    resolveSettledControlPanelWindowMode({ ...settledState, isControlPanel: false }),
    null
  );
  assert.equal(resolveSettledControlPanelWindowMode({ ...settledState, isLoading: true }), null);
  assert.equal(
    resolveSettledControlPanelWindowMode({ ...settledState, isWaitingForPolicyStart: true }),
    null
  );
  assert.equal(
    resolveSettledControlPanelWindowMode({ ...settledState, showOnboarding: true }),
    null
  );
});
