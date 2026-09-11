const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

// Restarting onboarding used to arm `pendingCloudMigration`, which a ControlPanel
// effect consumed after sign-in to force cloud routing regardless of the setup
// the user then chose in onboarding (#2086). The hook must only reset onboarding
// progress and reload; the routing pair is onboarding's to decide.
test("restarting onboarding resets progress without arming a cloud switch", async (t) => {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  let reloads = 0;
  const { storage } = installBrowserGlobals(t, {
    initialStorage: {
      onboardingCompleted: "true",
      transcriptionMode: "local",
      useLocalWhisper: "true",
    },
    window: {
      location: {
        reload() {
          reloads += 1;
        },
      },
    },
  });
  const container = installHookDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-use-start-onboarding-test-",
  });
  const { useStartOnboarding } = await vite.ssrLoadModule("/hooks/useStartOnboarding.ts");
  const { LEGACY_ONBOARDING_STEP_KEY } = await vite.ssrLoadModule("/components/onboarding/flow.ts");

  let startOnboarding;
  function Harness() {
    startOnboarding = useStartOnboarding();
    return null;
  }
  root = createRoot(container);
  await React.act(async () => {
    root.render(React.createElement(Harness));
  });

  startOnboarding();

  assert.equal(reloads, 1);
  assert.equal(storage.getItem("pendingCloudMigration"), null);
  assert.equal(storage.getItem("onboardingCompleted"), null);
  assert.equal(storage.getItem(LEGACY_ONBOARDING_STEP_KEY), "0");
  assert.equal(storage.getItem("transcriptionMode"), "local");
  assert.equal(storage.getItem("useLocalWhisper"), "true");
});
