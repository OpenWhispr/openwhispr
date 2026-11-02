const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

test("automatic-start checks use settled auth and live policy after asynchronous work", async (t) => {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  installBrowserGlobals(t);
  const container = installHookDom(t);
  globalThis.__meetingAuth = { isLoaded: false, isSignedIn: false };
  t.after(() => delete globalThis.__meetingAuth);
  const vite = await createRendererServer(t, {
    cachePrefix: "meeting-auto-policy-",
    mockModules: { "./useAuth": "export const useAuth = () => globalThis.__meetingAuth;" },
  });
  const hooks = await vite.ssrLoadModule("/hooks/usePolicy.ts");
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  let allowed;
  let check;
  function Harness() {
    allowed = hooks.useMeetingAutoTranscriptionAllowed();
    check = hooks.useMeetingAutoTranscriptionCheck();
    return null;
  }
  root = createRoot(container);
  const render = () => React.act(async () => root.render(React.createElement(Harness)));
  await render();
  assert.equal(allowed, false);
  assert.equal(check(), false);
  globalThis.__meetingAuth = { isLoaded: true, isSignedIn: false };
  await render();
  assert.equal(allowed, true);
  const pendingCheck = check;
  globalThis.__meetingAuth = { isLoaded: true, isSignedIn: true, isOfflineAccount: true };
  await render();
  assert.equal(pendingCheck(), false);
  await React.act(async () =>
    usePolicyStore.setState({
      status: "managed",
      policy: {
        minAppVersion: null,
        meetings: { transcriptionStart: "automatic" },
      },
    })
  );
  assert.equal(allowed, true);
  // No render is needed between a store update and the pending action's decision.
  await React.act(async () => {
    usePolicyStore.setState({
      policy: { minAppVersion: null, meetings: { transcriptionStart: "manual" } },
    });
    assert.equal(pendingCheck(), false);
  });
  assert.equal(allowed, false);
});
