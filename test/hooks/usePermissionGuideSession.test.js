const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

test("permission intent persists before React commits and explicit dismissal clears it", async (t) => {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  const { storage } = installBrowserGlobals(t);
  const container = installHookDom(t);
  const vite = await createRendererServer(t, { cachePrefix: "permission-guide-session-" });
  const { useOnboardingSession } = await vite.ssrLoadModule(
    "/components/onboarding/useOnboardingSession.ts"
  );
  let session;
  function Harness() {
    session = useOnboardingSession();
    return null;
  }
  root = createRoot(container);
  await React.act(async () => {
    root.render(React.createElement(Harness));
  });
  const progress = {
    current: "screen-context",
  };
  await React.act(async () => {
    session.setPermissionGuide(progress);
    session.setScreenContextRequested(true);
    const saved = JSON.parse(storage.getItem("onboardingSessionV2"));
    assert.equal(saved.screenContextRequested, true);
    assert.deepEqual(saved.permissionGuide, progress);
  });
  // Enabling another permission while Screen Context is still pending does not
  // withdraw the opt-in; only dismissing the guide does.
  await React.act(async () => {
    session.setPermissionGuide({ current: "accessibility" });
  });
  assert.equal(JSON.parse(storage.getItem("onboardingSessionV2")).screenContextRequested, true);
  await React.act(async () => {
    session.setPermissionGuide(progress);
    session.setScreenContextRequested(true);
    session.setPermissionGuide(null);
  });
  assert.equal(JSON.parse(storage.getItem("onboardingSessionV2")).screenContextRequested, false);
});
