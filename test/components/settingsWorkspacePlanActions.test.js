const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");
const React = require("react");
const { createRendererServer, installHappyDom } = require("../lib/rendererTestHarness");
const {
  businessDowngradeAction,
  enterpriseManageAction,
  enterpriseTileCta,
  entitledWorkspacePlans,
} = require("../../src/lib/workspaceBilling.ts");

const pricingKey = (suffix) => `settingsPage.account.pricing.${suffix}`;
const translate = (key, options) => (options?.returnObjects ? [] : key);
const enterprise = (overrides = {}) => ({
  id: "enterprise",
  plan: "enterprise",
  status: "active",
  role: "owner",
  stripe_subscription_id: "sub_enterprise",
  ...overrides,
});

// Render the actual SettingsPage cards so their caller props and conditional JSX
// stay covered without mounting unrelated settings tabs and device integrations.
function loadPricingCard(plan) {
  const source = fs.readFileSync(
    path.join(__dirname, "../../src/components/SettingsPage.tsx"),
    "utf8"
  );
  const ast = ts.createSourceFile(
    "SettingsPage.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  let card;
  function visit(node) {
    if (
      ts.isJsxElement(node) &&
      node.openingElement.tagName.getText(ast) === "div" &&
      node.openingElement.getText(ast).includes(`workspacePlans.has("${plan}")`)
    ) {
      assert.equal(card, undefined, `Expected a single ${plan} card`);
      card = node;
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(card, `Missing ${plan} pricing card`);
  const compiled = ts.transpileModule(
    `const { React, cn, t, Check, Mail, Button, WorkspacePlanActionButton,
      isSignedIn, workspacePlans, enterpriseCta, enterpriseAction, businessAction,
      usage, billingState, setBillingState, setEnterpriseCheckoutOpen, setEnterpriseWorkspaceCreateOpen, requestSignIn } = scope;
      return (${card.getText(ast)});`,
    { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2020 } }
  ).outputText;
  return new Function("scope", compiled);
}

async function setup(t) {
  const cleanup = [];
  const context = { after: (callback) => cleanup.push(callback) };
  t.after(async () => {
    for (const callback of cleanup.reverse()) await callback();
  });
  const happyWindow = await installHappyDom(context);
  const state = {
    workspaceRefreshes: [],
    portalIds: [],
    openedUrls: [],
    toasts: [],
    consoleOpens: 0,
    checkoutOpens: 0,
    createOpens: 0,
    portal: async () => "https://stripe.test/portal",
  };
  globalThis.__settingsBillingTest = state;
  t.after(() => delete globalThis.__settingsBillingTest);
  happyWindow.electronAPI = {
    openExternal: async (url) => state.openedUrls.push(url),
  };
  const vite = await createRendererServer(context, {
    noExternal: ["react-i18next"],
    cachePrefix: "openwhispr-settings-workspace-plan-",
    mockModules: {
      "react-i18next": "export const useTranslation = () => ({ t: (key) => key });",
      "/useAuth":
        "export const useAuth = () => ({ isSignedIn: true, isLoaded: true, user: { id: 'billing-user' } });",
      "/lib/auth": `export const withSessionRefresh = (operation) => operation();
        export const openAdminConsole = async () => { globalThis.__settingsBillingTest.consoleOpens++; };`,
      "/lib/authRequestContext": "export const hasValidatedAuthContext = () => true;",
      "/stores/workspaceStore": `export const useWorkspaceStore = (select) => select({
        refresh: async (options) => { globalThis.__settingsBillingTest.workspaceRefreshes.push(options); }
      });`,
      "/services/WorkspacesService": `export const WorkspacesService = {
        billingPortal: async (id) => {
          globalThis.__settingsBillingTest.portalIds.push(id);
          return globalThis.__settingsBillingTest.portal();
        }
      };`,
      "/ui/useToast":
        "export const useToast = () => ({ toast: (value) => globalThis.__settingsBillingTest.toasts.push(value) });",
      "../icons": "export const Loader2 = () => null;",
    },
  });
  const { createRoot } = require("react-dom/client");
  const container = happyWindow.document.createElement("div");
  const root = createRoot(container);
  context.after(() => React.act(() => root.unmount()));
  const { WorkspacePlanActionButton } = await vite.ssrLoadModule(
    "/components/settings/WorkspacePlanActionButton.tsx"
  );
  const { Button } = await vite.ssrLoadModule("/components/ui/button.tsx");
  const { useUsage } = await vite.ssrLoadModule("/hooks/useUsage.ts");
  const scopeFor = (workspaces, overrides = {}) => ({
    React,
    cn: (...values) => values.join(" "),
    t: translate,
    Check: () => null,
    Mail: () => null,
    Button,
    WorkspacePlanActionButton,
    isSignedIn: true,
    workspacePlans: entitledWorkspacePlans(workspaces),
    enterpriseCta: enterpriseTileCta(workspaces, "enterprise"),
    enterpriseAction: enterpriseManageAction(workspaces, "enterprise"),
    businessAction: businessDowngradeAction(workspaces, "enterprise"),
    usage: null,
    billingState: { business: false },
    setBillingState: () => {},
    setEnterpriseCheckoutOpen: () => state.checkoutOpens++,
    setEnterpriseWorkspaceCreateOpen: () => state.createOpens++,
    requestSignIn: () => {},
    ...overrides,
  });
  return { happyWindow, state, container, root, useUsage, scopeFor, WorkspacePlanActionButton };
}

function findButton(container, label) {
  return [...container.querySelectorAll("button")].find(
    (button) => button.textContent === pricingKey(label)
  );
}

for (const otherWorkspace of [
  { id: "free", plan: "free", role: "owner", status: "active", stripe_subscription_id: null },
  {
    id: "business",
    plan: "business",
    role: "owner",
    status: "active",
    stripe_subscription_id: "sub_business",
  },
]) {
  test(`Enterprise keeps its workspace label and Manage alongside upgrading another ${otherWorkspace.plan} workspace`, async (t) => {
    const { root, container, scopeFor, state } = await setup(t);
    const renderCard = loadPricingCard("enterprise");
    await React.act(async () => root.render(renderCard(scopeFor([enterprise(), otherWorkspace]))));
    assert.ok(container.textContent.includes(pricingKey("yourWorkspacePlan")));
    assert.ok(findButton(container, "manage"));
    assert.ok(findButton(container, "enterprise.upgradeCta"));
    await React.act(async () => findButton(container, "manage").click());
    assert.deepEqual(state.portalIds, ["enterprise"]);
    await React.act(async () => findButton(container, "enterprise.upgradeCta").click());
    assert.equal(state.checkoutOpens, 1);
    assert.equal(state.createOpens, 0);
  });
}

test("Enterprise retains sole-plan, non-owner, new-workspace, signed-out and loading actions", async (t) => {
  const { root, container, scopeFor, state } = await setup(t);
  const renderCard = loadPricingCard("enterprise");
  for (const fixture of [
    { workspaces: [enterprise()], badge: true, manage: true, upgrade: false, sales: false },
    {
      workspaces: [enterprise({ role: "member", billing_manager: "Alice" })],
      badge: true,
      manage: false,
      upgrade: false,
      sales: false,
    },
    {
      workspaces: [{ id: "free", plan: "free", role: "owner", status: "active" }],
      badge: false,
      manage: false,
      upgrade: true,
      sales: true,
    },
    { workspaces: [], badge: false, manage: false, upgrade: true, sales: true, create: true },
    {
      workspaces: [],
      overrides: { isSignedIn: false },
      badge: false,
      manage: false,
      upgrade: false,
      sales: true,
    },
    {
      workspaces: [],
      overrides: { enterpriseCta: { action: "contactSales", ownerName: null } },
      badge: false,
      manage: false,
      upgrade: false,
      sales: true,
    },
  ]) {
    await React.act(async () =>
      root.render(renderCard(scopeFor(fixture.workspaces, fixture.overrides)))
    );
    assert.equal(container.textContent.includes(pricingKey("yourWorkspacePlan")), fixture.badge);
    assert.equal(Boolean(findButton(container, "manage")), fixture.manage);
    assert.equal(Boolean(findButton(container, "enterprise.upgradeCta")), fixture.upgrade);
    assert.equal(Boolean(findButton(container, "enterprise.cta")), fixture.sales);
    if (fixture.create) {
      await React.act(async () => findButton(container, "enterprise.upgradeCta").click());
      assert.equal(state.createOpens, 1);
    }
  }
});

for (const plan of ["business", "enterprise"]) {
  test(`${plan} Settings card refreshes account entitlement on portal return and every retry after its button unmounts`, async (t) => {
    const { happyWindow, state, root, container, useUsage, scopeFor } = await setup(t);
    const renderCard = loadPricingCard(plan);
    let entitlementActive = true;
    let usageCalls = 0;
    let latestUsage;
    let showCard = true;
    t.mock.timers.enable({ apis: ["setTimeout"] });
    happyWindow.electronAPI.cloudUsage = async () => {
      usageCalls++;
      return {
        success: true,
        plan: "free",
        status: "active",
        isSubscribed: entitlementActive,
        isTrial: false,
        limit: entitlementActive ? -1 : 2000,
        entitlementSources: {
          personal: false,
          workspaceIds: entitlementActive ? ["enterprise"] : [],
        },
      };
    };
    function Harness() {
      latestUsage = useUsage();
      return showCard ? renderCard(scopeFor([enterprise()], { usage: latestUsage })) : null;
    }
    await React.act(async () => root.render(React.createElement(Harness)));
    assert.equal(usageCalls, 1);
    assert.equal(latestUsage.hasPaidAccess, true);
    assert.deepEqual(latestUsage.entitledWorkspaceIds, ["enterprise"]);
    await React.act(async () =>
      findButton(container, plan === "business" ? "downgrade" : "manage").click()
    );
    assert.deepEqual(state.openedUrls, ["https://stripe.test/portal"]);
    showCard = false;
    await React.act(async () => root.render(React.createElement(Harness)));
    assert.equal(container.querySelector("button"), null);
    await React.act(async () => happyWindow.dispatchEvent(new happyWindow.Event("focus")));
    assert.equal(usageCalls, 2, "focus refreshes usage even before the webhook arrives");
    assert.equal(latestUsage.hasPaidAccess, true);
    entitlementActive = false;
    for (const [index, elapsed] of [4000, 4000, 8000].entries()) {
      await React.act(async () => t.mock.timers.tick(elapsed));
      assert.equal(usageCalls, index + 3, "each retry refreshes account usage");
      assert.equal(latestUsage.hasPaidAccess, false);
      assert.equal(latestUsage.isSubscribed, false);
      assert.deepEqual(latestUsage.entitledWorkspaceIds, []);
    }
    assert.deepEqual(
      state.workspaceRefreshes,
      Array.from({ length: 4 }, () => ({ fresh: true }))
    );
  });
}

test("workspace plan actions keep console/sales separate and recover from portal errors", async (t) => {
  const { root, container, state, happyWindow, WorkspacePlanActionButton } = await setup(t);
  let entitlementRefreshes = 0;
  const renderAction = async (action) =>
    React.act(async () =>
      root.render(
        React.createElement(WorkspacePlanActionButton, {
          action,
          label: "Action",
          onRefreshEntitlement: async () => {
            entitlementRefreshes++;
          },
        })
      )
    );
  for (const kind of ["console", "contactSales"]) {
    await renderAction({ kind });
    await React.act(async () => container.querySelector("button").click());
    await React.act(async () => happyWindow.dispatchEvent(new happyWindow.Event("focus")));
  }
  assert.equal(state.consoleOpens, 1);
  assert.deepEqual(state.openedUrls, ["https://openwhispr.com/contact-sales"]);
  assert.equal(entitlementRefreshes, 0);
  assert.deepEqual(state.workspaceRefreshes, []);
  let rejectPortal;
  state.portal = () =>
    new Promise((resolve, reject) => {
      rejectPortal = reject;
    });
  await renderAction({ kind: "stripePortal", workspaceId: "enterprise" });
  await React.act(async () => container.querySelector("button").click());
  assert.equal(container.querySelector("button").disabled, true);
  await React.act(async () => rejectPortal(new Error("Portal unavailable")));
  assert.equal(container.querySelector("button").disabled, false);
  assert.equal(state.toasts[0].description, "Portal unavailable");
  await React.act(async () => happyWindow.dispatchEvent(new happyWindow.Event("focus")));
  assert.equal(entitlementRefreshes, 0);
  assert.deepEqual(state.workspaceRefreshes, []);
});
