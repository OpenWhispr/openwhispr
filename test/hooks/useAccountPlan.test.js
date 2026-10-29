const assert = require("node:assert/strict");
const test = require("node:test");
const { createElement } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const usage = (overrides = {}) => ({
  status: "success",
  plan: "free",
  isTrial: false,
  isPastDue: false,
  isPersonallySubscribed: false,
  storeBilling: null,
  currentPeriodEnd: null,
  entitledWorkspaceIds: [],
  ...overrides,
});

test("the account's plan label matches Settings → Plans & Billing", async (t) => {
  t.after(() => delete globalThis.__workspaces);
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-use-account-plan-",
    mockModules: {
      "/stores/workspaceStore": `
        export const useWorkspaceStore = (selector) =>
          selector({ workspaces: globalThis.__workspaces ?? [] });
      `,
    },
  });
  const { useAccountPlan } = await vite.ssrLoadModule("/hooks/useAccountPlan.ts");
  const labelFor = (usageResult, workspaces = []) => {
    globalThis.__workspaces = workspaces;
    let label;
    function Probe() {
      label = useAccountPlan(usageResult).planLabel;
      return null;
    }
    renderToStaticMarkup(createElement(Probe));
    return label;
  };
  const acme = { id: "acme", name: "Acme", plan: "business" };

  assert.equal(labelFor(null), null);
  assert.equal(labelFor(usage({ status: "loading" })), null);
  assert.equal(labelFor(usage()), "settingsPage.account.planLabels.free");
  assert.equal(labelFor(usage({ isTrial: true })), "settingsPage.account.planLabels.trial");
  assert.equal(labelFor(usage({ isPastDue: true })), "settingsPage.account.planLabels.free");
  assert.equal(
    labelFor(usage({ isPersonallySubscribed: true, plan: "pro" })),
    "settingsPage.account.planLabels.pro"
  );
  assert.equal(
    labelFor(usage({ isPersonallySubscribed: true, plan: "business" })),
    "settingsPage.account.planLabels.business"
  );
  // A workspace seat names the workspace's plan, and waits until the workspace list arrives.
  const covered = usage({ entitledWorkspaceIds: ["acme"] });
  assert.equal(labelFor(covered, [acme]), "settingsPage.workspace.billing.planLabel.business");
  assert.equal(labelFor(covered, []), null);
});
