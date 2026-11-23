const assert = require("node:assert/strict");
const test = require("node:test");
const React = require("react");
const { createRendererServer, installHappyDom } = require("../lib/rendererTestHarness");

const ID = "0b6f1f9e-2c1a-4a8e-9d5b-3f2e1c0a9b8d";

async function setup(t) {
  const cleanup = [];
  const context = { after: (callback) => cleanup.push(callback) };
  t.after(async () => {
    for (const callback of cleanup.reverse()) await callback();
  });
  const happyWindow = await installHappyDom(context);
  const state = { boundaryListeners: new Set() };
  globalThis.__billingRequestTest = state;
  t.after(() => delete globalThis.__billingRequestTest);
  const vite = await createRendererServer(context, {
    cachePrefix: "openwhispr-plans-billing-request-",
    mockModules: {
      "/lib/authRequestContext": `export const subscribeAuthBoundary = (onChange) => {
        const listeners = globalThis.__billingRequestTest.boundaryListeners;
        listeners.add(onChange);
        return () => listeners.delete(onChange);
      };`,
      // The hook must never follow the active workspace; a store that names one proves it doesn't.
      "/stores/workspaceStore": `export const useWorkspaceStore = (select) => select({
        activeWorkspaceId: "active-ws"
      });`,
    },
  });
  const { usePlansBillingRequest } = await vite.ssrLoadModule(
    "/components/settings/billing/usePlansBillingRequest.ts"
  );
  const { createRoot } = require("react-dom/client");
  const container = happyWindow.document.createElement("div");
  const root = createRoot(container);
  context.after(() => React.act(() => root.unmount()));

  let latest;
  function Probe({ initialSection, activeSection }) {
    latest = usePlansBillingRequest(initialSection, activeSection);
    return null;
  }
  const render = (initialSection, activeSection) =>
    React.act(async () =>
      root.render(React.createElement(Probe, { initialSection, activeSection }))
    );
  return {
    state,
    render,
    current: () => latest[0],
    setRequest: (request) => React.act(async () => latest[1](request)),
    fireBoundary: () =>
      React.act(async () => {
        for (const listener of state.boundaryListeners) listener();
      }),
  };
}

test("opens on Personal whatever the active workspace is", async (t) => {
  const { render, current } = await setup(t);
  await render("plansBilling", "plansBilling");
  assert.deepEqual(current(), { kind: "personal" });
});

test("opens on Personal with no requested section", async (t) => {
  const { render, current } = await setup(t);
  await render(undefined, "plansBilling");
  assert.deepEqual(current(), { kind: "personal" });
});

test("a workspace target opens that workspace", async (t) => {
  const { render, current } = await setup(t);
  await render(`plansBilling:workspace:${ID}`, "plansBilling");
  assert.deepEqual(current(), { kind: "workspace", workspaceId: ID });
});

test("coming back to Plans & Billing from another section resets to Personal", async (t) => {
  const { render, current, setRequest } = await setup(t);
  await render("plansBilling", "plansBilling");
  await setRequest({ kind: "workspace", workspaceId: ID });
  assert.deepEqual(current(), { kind: "workspace", workspaceId: ID });
  await render("plansBilling", "workspacePeople");
  await render("plansBilling", "plansBilling");
  assert.deepEqual(current(), { kind: "personal" });
});

test("staying on Plans & Billing keeps the picked view", async (t) => {
  const { render, current, setRequest } = await setup(t);
  await render("plansBilling", "plansBilling");
  await setRequest({ kind: "workspace", workspaceId: ID });
  await render("plansBilling", "plansBilling");
  assert.deepEqual(current(), { kind: "workspace", workspaceId: ID });
});

test("an account change resets to Personal", async (t) => {
  const { render, current, setRequest, fireBoundary, state } = await setup(t);
  await render("plansBilling", "plansBilling");
  await setRequest({ kind: "workspace", workspaceId: ID });
  await fireBoundary();
  assert.deepEqual(current(), { kind: "personal" });
  assert.equal(state.boundaryListeners.size, 1);
});
