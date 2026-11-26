const assert = require("node:assert/strict");
const test = require("node:test");
const React = require("react");
const { createRendererServer, installHappyDom } = require("../lib/rendererTestHarness");
const {
  businessDowngradeAction,
  businessTileAction,
  enterpriseManageAction,
  enterpriseTileAction,
  entitledWorkspacePlans,
  hasActiveWorkspaceSubscription,
} = require("../../src/lib/workspaceBilling.ts");
const en = require("../../src/locales/en/translation.json");
const de = require("../../src/locales/de/translation.json");

const pricingKey = (suffix) => `settingsPage.account.pricing.${suffix}`;
const tileKey = (label) => `settingsPage.billing.tiles.${label}`;
const enterprise = (overrides = {}) => ({
  id: "enterprise",
  plan: "enterprise",
  status: "active",
  role: "owner",
  stripe_subscription_id: "sub_enterprise",
  ...overrides,
});

const ICONS = [
  "Loader2",
  "Zap",
  "Building2",
  "Shield",
  "AudioLines",
  "MonitorSmartphone",
  "Link2",
  "Code2",
  "Users",
  "Brain",
  "MessageSquare",
  "MessageCircle",
  "Key",
  "ShieldCheck",
  "Sliders",
  "Mail",
];

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
    authGeneration: 7,
    openedUrls: [],
    toasts: [],
    consoleOpens: 0,
    proClicks: 0,
    signIns: 0,
    yearlyChanges: [],
    businessActions: [],
    enterpriseActions: [],
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
      "/stores/affiliateStore": `export const prepareAffiliateCheckout = async () => true;`,
      "react-i18next": "export const useTranslation = () => ({ t: (key) => key });",
      "/useAuth":
        "export const useAuth = () => ({ isSignedIn: true, isLoaded: true, user: { id: 'billing-user' } });",
      "/lib/auth": `export const withSessionRefresh = (operation) => operation();
        export const openAdminConsole = async () => { globalThis.__settingsBillingTest.consoleOpens++; };`,
      "/lib/authRequestContext":
        "export const hasValidatedAuthContext = () => true; export const getValidatedAuthGeneration = () => globalThis.__settingsBillingTest.authGeneration;",
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
      "/icons": ICONS.map((name) => `export const ${name} = () => null;`).join("\n"),
    },
  });
  const { createRoot } = require("react-dom/client");
  const container = happyWindow.document.createElement("div");
  const root = createRoot(container);
  context.after(() => React.act(() => root.unmount()));
  const { WorkspacePlanActionButton } = await vite.ssrLoadModule(
    "/components/settings/WorkspacePlanActionButton.tsx"
  );
  const { PlansGrid } = await vite.ssrLoadModule("/components/settings/billing/PlansGrid.tsx");
  const { useUsage } = await vite.ssrLoadModule("/hooks/useUsage.ts");
  const { useBillingPortal } = await vite.ssrLoadModule("/hooks/useBillingPortal.ts");
  const entitledIds = (workspaces) =>
    workspaces
      .filter((workspace) => hasActiveWorkspaceSubscription(workspace))
      .map((workspace) => workspace.id);
  const propsFor = (workspaces, overrides = {}) => ({
    isSignedIn: true,
    yearly: true,
    onYearlyChange: (yearly) => state.yearlyChanges.push(yearly),
    pro: { kind: "subscribe", busy: false, onClick: () => state.proClicks++ },
    business: businessTileAction({
      listLoaded: true,
      entitledWorkspaceIds: entitledIds(workspaces),
      workspaces,
      defaultWorkspaceId: null,
    }),
    businessDowngrade: businessDowngradeAction(workspaces, "enterprise"),
    onBusinessAction: (action) => state.businessActions.push(action),
    enterprise: {
      action: enterpriseTileAction({
        listLoaded: true,
        entitledWorkspaceIds: entitledIds(workspaces),
        workspaces,
        defaultWorkspaceId: null,
        activeWorkspaceId: "enterprise",
      }),
      manage: enterpriseManageAction(workspaces, "enterprise"),
      entitled: entitledWorkspacePlans(workspaces).has("enterprise"),
    },
    onEnterprise: (action) => state.enterpriseActions.push(action),
    ...overrides,
  });
  const signedOut = {
    isSignedIn: false,
    pro: { kind: "signIn" },
    onSignIn: () => state.signIns++,
    business: { kind: "none" },
  };
  const render = (props) =>
    React.act(async () => root.render(React.createElement(PlansGrid, props)));
  return {
    happyWindow,
    state,
    container,
    root,
    useUsage,
    useBillingPortal,
    propsFor,
    signedOut,
    render,
    PlansGrid,
    WorkspacePlanActionButton,
  };
}

const card = (container, plan) => container.querySelector(`[data-plan="${plan}"]`);

function findButton(scope, key) {
  return [...scope.querySelectorAll("button")].find((button) => button.textContent === key);
}

// PillButton names its variant "primary"; a ui Button (WorkspacePlanActionButton) calls it "default".
const isPrimary = (button) => ["primary", "default"].includes(button.getAttribute("data-variant"));

function resolve(locale, key) {
  return key.split(".").reduce((node, part) => (node == null ? undefined : node[part]), locale);
}

function renderedTexts(container) {
  const walker = container.ownerDocument.createTreeWalker(container, 4);
  const texts = [];
  while (walker.nextNode()) {
    const text = walker.currentNode.textContent.trim();
    if (text) texts.push(text);
  }
  return texts;
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
  test(`Enterprise keeps its workspace label and Manage alongside a view switch to another ${otherWorkspace.plan} workspace`, async (t) => {
    const { container, propsFor, render, state } = await setup(t);
    await render(propsFor([enterprise(), otherWorkspace]));
    const enterpriseCard = card(container, "enterprise");
    assert.equal(enterpriseCard.textContent.includes(pricingKey("yourWorkspacePlan")), true);
    assert.equal(Boolean(findButton(enterpriseCard, pricingKey("manage"))), true);
    assert.equal(Boolean(findButton(enterpriseCard, tileKey("upgradeWorkspace"))), true);
    await React.act(async () => findButton(enterpriseCard, pricingKey("manage")).click());
    assert.deepEqual(state.portalIds, ["enterprise"]);
    await React.act(async () => findButton(enterpriseCard, tileKey("upgradeWorkspace")).click());
    assert.deepEqual(state.enterpriseActions, [
      { kind: "viewWorkspace", workspaceId: otherWorkspace.id },
    ]);
  });
}

test("Enterprise tile: workspace plan, view switch, ask-owner, signed-out and loading actions", async (t) => {
  const { container, propsFor, signedOut, render, state } = await setup(t);
  const memberOfFree = {
    id: "team",
    plan: "free",
    role: "member",
    status: "active",
    billing_manager: "Alice",
  };
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
      clickUpgrade: { kind: "viewWorkspace", workspaceId: "free" },
    },
    {
      // No workspace to upgrade: contact sales, never a create-workspace purchase path.
      workspaces: [],
      badge: false,
      manage: false,
      upgrade: false,
      sales: true,
      clickSales: { kind: "contactSales", ownerName: null },
    },
    {
      workspaces: [memberOfFree],
      badge: false,
      manage: false,
      upgrade: false,
      sales: true,
      askOwner: true,
      clickSales: { kind: "contactSales", ownerName: "Alice" },
    },
    {
      workspaces: [],
      overrides: signedOut,
      badge: false,
      manage: false,
      upgrade: false,
      sales: true,
      clickSales: { kind: "contactSales", ownerName: null },
    },
    {
      workspaces: [],
      enterpriseAction: { kind: "none" },
      badge: false,
      manage: false,
      upgrade: false,
      sales: false,
    },
  ]) {
    const props = propsFor(fixture.workspaces, fixture.overrides);
    if (fixture.enterpriseAction)
      props.enterprise = { ...props.enterprise, action: fixture.enterpriseAction };
    await render(props);
    const enterpriseCard = card(container, "enterprise");
    assert.equal(
      enterpriseCard.textContent.includes(pricingKey("yourWorkspacePlan")),
      fixture.badge
    );
    assert.equal(Boolean(findButton(enterpriseCard, pricingKey("manage"))), fixture.manage);
    assert.equal(Boolean(findButton(enterpriseCard, tileKey("upgradeWorkspace"))), fixture.upgrade);
    assert.equal(
      Boolean(findButton(enterpriseCard, pricingKey("enterprise.upgradeCta"))),
      false,
      "the Personal grid never offers the Enterprise purchase"
    );
    assert.equal(Boolean(findButton(enterpriseCard, pricingKey("enterprise.cta"))), fixture.sales);
    assert.equal(
      enterpriseCard.textContent.includes(pricingKey("enterprise.askOwner")),
      Boolean(fixture.askOwner)
    );
    state.enterpriseActions.length = 0;
    if (fixture.clickUpgrade) {
      await React.act(async () => findButton(enterpriseCard, tileKey("upgradeWorkspace")).click());
      assert.deepEqual(state.enterpriseActions, [fixture.clickUpgrade]);
    }
    if (fixture.clickSales) {
      state.enterpriseActions.length = 0;
      await React.act(async () => findButton(enterpriseCard, pricingKey("enterprise.cta")).click());
      assert.deepEqual(state.enterpriseActions, [fixture.clickSales]);
    }
  }
});

for (const plan of ["business", "enterprise"]) {
  test(`${plan} Plans card refreshes account entitlement on portal return and every retry after its button unmounts`, async (t) => {
    const { happyWindow, state, root, container, useUsage, propsFor, PlansGrid } = await setup(t);
    let entitlementActive = true;
    let usageCalls = 0;
    let latestUsage;
    let showGrid = true;
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
      return showGrid
        ? React.createElement(
            PlansGrid,
            propsFor([enterprise()], { onRefreshEntitlement: latestUsage.refetch })
          )
        : null;
    }
    await React.act(async () => root.render(React.createElement(Harness)));
    assert.equal(usageCalls, 1);
    assert.equal(latestUsage.hasPaidAccess, true);
    assert.deepEqual(latestUsage.entitledWorkspaceIds, ["enterprise"]);
    await React.act(async () =>
      findButton(
        card(container, plan),
        pricingKey(plan === "business" ? "downgrade" : "manage")
      ).click()
    );
    assert.deepEqual(state.openedUrls, ["https://stripe.test/portal"]);
    showGrid = false;
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

test("Business downgrade offers contact sales when the portal can't serve it", async (t) => {
  const { container, propsFor, render, state } = await setup(t);
  await render(propsFor([], { businessDowngrade: { kind: "contactSales" } }));
  const businessCard = card(container, "business");
  assert.equal(Boolean(findButton(businessCard, pricingKey("downgrade"))), false);
  await React.act(async () => findButton(businessCard, pricingKey("enterprise.cta")).click());
  assert.deepEqual(state.openedUrls, ["https://openwhispr.com/contact-sales"]);
});

test("Manage and Business Downgrade are full-width h-8 secondary pills", async (t) => {
  const { container, propsFor, render } = await setup(t);
  await render(propsFor([enterprise()]));
  const manage = findButton(card(container, "enterprise"), pricingKey("manage"));
  const downgrade = findButton(card(container, "business"), pricingKey("downgrade"));
  for (const button of [manage, downgrade]) {
    const classes = button.className.split(/\s+/);
    for (const expected of ["h-8", "w-full", "rounded-full", "bg-surface-3", "text-xs"]) {
      assert.equal(classes.includes(expected), true, `missing ${expected}`);
    }
    assert.equal(classes.includes("h-6"), false);
    assert.equal(isPrimary(button), false);
  }
});

test("WorkspacePlanActionButton keeps its default look without a className", async (t) => {
  const { root, container, WorkspacePlanActionButton } = await setup(t);
  await React.act(async () =>
    root.render(
      React.createElement(WorkspacePlanActionButton, { action: { kind: "console" }, label: "Go" })
    )
  );
  const classes = container.querySelector("button").className.split(/\s+/);
  assert.equal(classes.includes("h-6"), true);
  assert.equal(classes.includes("text-[10px]"), true);
  assert.equal(classes.includes("bg-surface-3"), false);
});

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

test("Business tile: a solo default workspace gets a view switch", async (t) => {
  const { container, propsFor, render, state } = await setup(t);
  const solo = { id: "default", plan: "free", role: "owner", status: "active" };
  await render(propsFor([solo], { business: { kind: "viewWorkspace", workspaceId: "default" } }));
  const businessCard = card(container, "business");
  assert.equal(Boolean(findButton(businessCard, tileKey("createWorkspace"))), false);
  const button = findButton(businessCard, tileKey("upgradeWorkspace"));
  assert.equal(isPrimary(button), false);
  await React.act(async () => button.click());
  assert.deepEqual(state.businessActions, [{ kind: "viewWorkspace", workspaceId: "default" }]);
  assert.deepEqual(state.enterpriseActions, []);
});

test("Business tile: Create workspace asks for the create flow", async (t) => {
  const { container, propsFor, render, state } = await setup(t);
  await render(propsFor([], { business: { kind: "createWorkspace" } }));
  const businessCard = card(container, "business");
  assert.equal(Boolean(findButton(businessCard, tileKey("upgradeWorkspace"))), false);
  const button = findButton(businessCard, tileKey("createWorkspace"));
  assert.equal(isPrimary(button), false);
  await React.act(async () => button.click());
  assert.deepEqual(state.businessActions, [{ kind: "createWorkspace" }]);
  assert.deepEqual(state.enterpriseActions, []);
});

test("Business tile: a covering Business workspace shows the workspace label and no button", async (t) => {
  const { container, propsFor, render } = await setup(t);
  await render(propsFor([], { business: { kind: "workspacePlan" } }));
  const businessCard = card(container, "business");
  assert.equal(businessCard.textContent.includes(pricingKey("yourWorkspacePlan")), true);
  assert.equal(businessCard.querySelectorAll("button").length, 0);
});

test("signed out: Pro's Sign in is the only primary button, and Business still signs in", async (t) => {
  const { container, propsFor, signedOut, render, state } = await setup(t);
  await render(propsFor([], signedOut));
  const primaries = [...container.querySelectorAll("button")].filter(isPrimary);
  assert.equal(primaries.length, 1);
  assert.equal(card(container, "pro").contains(primaries[0]), true);
  assert.equal(primaries[0].textContent, "common.signIn");
  await React.act(async () => primaries[0].click());
  const businessButton = findButton(card(container, "business"), pricingKey("business.cta"));
  assert.equal(isPrimary(businessButton), false);
  await React.act(async () => businessButton.click());
  assert.equal(state.signIns, 2);
  assert.deepEqual(state.businessActions, []);
});

test("Enterprise tile: Upgrade a workspace is secondary and only asks for the view switch", async (t) => {
  const { container, propsFor, render, state } = await setup(t);
  await render(propsFor([{ id: "free", plan: "free", role: "owner", status: "active" }]));
  const button = findButton(card(container, "enterprise"), tileKey("upgradeWorkspace"));
  assert.equal(Boolean(button), true);
  assert.equal(isPrimary(button), false);
  const primaries = [...container.querySelectorAll("button")].filter(isPrimary);
  assert.equal(primaries.length, 1);
  assert.equal(card(container, "pro").contains(primaries[0]), true);
  await React.act(async () => button.click());
  assert.deepEqual(state.enterpriseActions, [{ kind: "viewWorkspace", workspaceId: "free" }]);
});

test("Pro card: subscribe starts checkout, busy disables it, current and covered show labels", async (t) => {
  const { container, propsFor, render, state } = await setup(t);
  await render(propsFor([]));
  const subscribe = findButton(
    card(container, "pro"),
    "settingsPage.account.checkout.upgradeToPro"
  );
  assert.equal(isPrimary(subscribe), true);
  await React.act(async () => subscribe.click());
  assert.equal(state.proClicks, 1);

  await render(propsFor([], { pro: { kind: "subscribe", busy: true, onClick: () => {} } }));
  const busy = card(container, "pro").querySelector("button");
  assert.equal(busy.disabled, true);

  await render(propsFor([], { pro: { kind: "current" } }));
  assert.equal(card(container, "pro").querySelectorAll("button").length, 0);
  assert.equal(
    card(container, "pro").textContent.includes("settingsPage.billing.plans.yourPlan"),
    true
  );

  await render(propsFor([], { pro: { kind: "covered" } }));
  assert.equal(card(container, "pro").querySelectorAll("button").length, 0);
  assert.equal(card(container, "pro").textContent.includes(pricingKey("coveredByWorkspace")), true);
});

test("Pro card: a personal Business subscriber gets a secondary Downgrade", async (t) => {
  const { container, propsFor, render } = await setup(t);
  let downgrades = 0;
  await render(
    propsFor([], { pro: { kind: "downgrade", busy: false, onClick: () => downgrades++ } })
  );
  const proCard = card(container, "pro");
  assert.equal(proCard.querySelectorAll("button").length, 1);
  const downgrade = findButton(proCard, pricingKey("downgrade"));
  assert.equal(isPrimary(downgrade), false);
  assert.equal(downgrade.disabled, false);
  await React.act(async () => downgrade.click());
  assert.equal(downgrades, 1);

  await render(propsFor([], { pro: { kind: "downgrade", busy: true, onClick: () => {} } }));
  assert.equal(card(container, "pro").querySelector("button").disabled, true);
});

test("Pro card: an unknown plan state shows no button and no label", async (t) => {
  const { container, propsFor, render } = await setup(t);
  await render(propsFor([], { pro: { kind: "none" } }));
  const proCard = card(container, "pro");
  assert.equal(proCard.querySelectorAll("button").length, 0);
  for (const key of [
    "settingsPage.billing.plans.yourPlan",
    pricingKey("coveredByWorkspace"),
    "settingsPage.account.checkout.upgradeToPro",
    "common.signIn",
  ]) {
    assert.equal(proCard.textContent.includes(key), false, `${key} shown`);
  }
  assert.equal(proCard.textContent.includes(pricingKey("pro.name")), true);
});

test("the yearly switch sits in the Plans header and picks the yearly or monthly prices", async (t) => {
  const { container, propsFor, render, state } = await setup(t);
  await render(propsFor([]));
  const switches = container.querySelectorAll('[role="switch"]');
  assert.equal(switches.length, 1);
  assert.equal(switches[0].getAttribute("aria-checked"), "true");
  assert.equal(switches[0].getAttribute("aria-label"), pricingKey("billedYearly"));
  const label = switches[0].closest("label");
  assert.ok(label, "the switch sits in a label");
  assert.equal(label.textContent, pricingKey("billedYearly"));
  assert.equal(card(container, "pro").contains(switches[0]), false);
  assert.equal(
    card(container, "pro").textContent.includes("settingsPage.billing.plans.pricePerMonthYearly"),
    true
  );
  assert.equal(
    card(container, "business").textContent.includes(
      "settingsPage.billing.plans.pricePerSeatYearly"
    ),
    true
  );
  await React.act(async () => switches[0].click());
  assert.deepEqual(state.yearlyChanges, [false]);

  await render(propsFor([], { yearly: false }));
  assert.equal(container.querySelector('[role="switch"]').getAttribute("aria-checked"), "false");
  assert.equal(
    card(container, "pro").textContent.includes("settingsPage.billing.plans.pricePerMonth"),
    true
  );
  assert.equal(
    card(container, "pro").textContent.includes("settingsPage.billing.plans.pricePerMonthYearly"),
    false
  );
  assert.equal(
    card(container, "business").textContent.includes("settingsPage.billing.plans.pricePerSeat"),
    true
  );
});

test("no card advertises meeting hours, in English or German", async (t) => {
  const { container, propsFor, signedOut, render } = await setup(t);
  for (const props of [propsFor([]), propsFor([], signedOut), propsFor([enterprise()])]) {
    await render(props);
    const texts = renderedTexts(container);
    assert.ok(texts.length > 10, "the grid rendered its text");
    for (const key of texts) {
      const english = resolve(en, key);
      assert.equal(typeof english, "string", `${key} is an English string key`);
      assert.doesNotMatch(english, /hour/i, `${key} mentions hours`);
      assert.doesNotMatch(String(resolve(de, key)), /stunde/i, `${key} mentions Stunden`);
    }
  }
});

const workspaceGridProps = (overrides = {}) => ({
  isSignedIn: true,
  cards: ["business", "enterprise"],
  business: { kind: "checkout", busy: false, disabled: false },
  businessDowngrade: null,
  onBusinessAction: (action) => globalThis.__settingsBillingTest.businessActions.push(action),
  enterprise: { action: { kind: "checkout" }, manage: null, entitled: false },
  onEnterprise: (action) => globalThis.__settingsBillingTest.enterpriseActions.push(action),
  columns: 2,
  ...overrides,
});

test("Business and Enterprise grid switches Business billing cadence in its own view", async (t) => {
  const { state, container, render } = await setup(t);
  const change = (yearly) => state.yearlyChanges.push(yearly);
  await render(workspaceGridProps({ yearly: true, onYearlyChange: change }));
  assert.equal(card(container, "pro"), null);
  assert.ok(card(container, "enterprise"));
  assert.ok(
    card(container, "business").textContent.includes(
      "settingsPage.billing.plans.pricePerSeatYearly"
    )
  );
  await React.act(async () => container.querySelector('[role="switch"]').click());
  assert.deepEqual(state.yearlyChanges, [false]);
  await render(workspaceGridProps({ yearly: false, onYearlyChange: change }));
  assert.equal(
    card(container, "business").textContent.includes(
      "settingsPage.billing.plans.pricePerSeatYearly"
    ),
    false
  );
});

test("cards: Business checkout is secondary, and spins while busy", async (t) => {
  const { container, render, state } = await setup(t);
  const upgrade = "settingsPage.billing.free.upgradeToBusiness";
  await render(workspaceGridProps());
  const secondary = findButton(card(container, "business"), upgrade);
  assert.equal(secondary.getAttribute("data-variant"), "secondary");
  await React.act(async () => secondary.click());
  assert.equal(state.businessActions.length, 1);
  assert.equal(state.businessActions[0].kind, "checkout");

  await render(workspaceGridProps({ business: { kind: "checkout", busy: true, disabled: true } }));
  const busy = card(container, "business").querySelector("button");
  assert.equal(busy.disabled, true);
  assert.equal(busy.getAttribute("aria-busy"), "true");
  assert.equal(busy.getAttribute("data-variant"), "secondary");
});

test("cards: Enterprise checkout offers the purchase and contact sales", async (t) => {
  const { container, render, state } = await setup(t);
  await render(workspaceGridProps());
  const enterpriseCard = card(container, "enterprise");
  const upgrade = findButton(enterpriseCard, pricingKey("enterprise.upgradeCta"));
  assert.equal(isPrimary(upgrade), false);
  await React.act(async () => upgrade.click());
  await React.act(async () => findButton(enterpriseCard, pricingKey("enterprise.cta")).click());
  assert.deepEqual(state.enterpriseActions, [
    { kind: "checkout" },
    { kind: "contactSales", ownerName: null },
  ]);
});

test("personal portal refreshes details once on return for the same sign-in", async (t) => {
  const { happyWindow, state, root, useUsage } = await setup(t);
  let usageCalls = 0;
  let refreshes = 0;
  let latestUsage;
  happyWindow.electronAPI.cloudUsage = async () => {
    usageCalls++;
    return {
      success: true,
      plan: "pro",
      status: "trialing",
      isTrial: false,
      isSubscribed: true,
      entitlementSources: { personal: true, workspaceIds: [] },
    };
  };
  const portalGenerations = [];
  happyWindow.electronAPI.cloudBillingPortal = async (generation) => {
    portalGenerations.push(generation);
    return { success: true, url: "https://stripe.test/personal" };
  };
  function Harness() {
    latestUsage = useUsage();
    return null;
  }
  await React.act(async () => root.render(React.createElement(Harness)));
  assert.equal(latestUsage.status, "success");
  assert.equal(latestUsage.subscriptionStatus, "trialing");
  await React.act(async () => latestUsage.openBillingPortal(() => refreshes++));
  assert.deepEqual(state.openedUrls, ["https://stripe.test/personal"]);
  assert.deepEqual(portalGenerations, [7]);
  assert.equal(refreshes, 0);
  await React.act(async () => happyWindow.dispatchEvent(new happyWindow.Event("focus")));
  assert.equal(usageCalls, 2);
  assert.equal(refreshes, 1);
  await React.act(async () => happyWindow.dispatchEvent(new happyWindow.Event("focus")));
  assert.equal(refreshes, 1);
});

test("personal portal focus ignores a return after the authenticated generation changes", async (t) => {
  const { happyWindow, state, root, useUsage } = await setup(t);
  let usageCalls = 0;
  let refreshes = 0;
  let latestUsage;
  happyWindow.electronAPI.cloudUsage = async () => {
    usageCalls++;
    return { success: true, plan: "pro", status: "active", isSubscribed: true };
  };
  happyWindow.electronAPI.cloudBillingPortal = async () => ({
    success: true,
    url: "https://stripe.test/personal",
  });
  function Harness() {
    latestUsage = useUsage();
    return null;
  }
  await React.act(async () => root.render(React.createElement(Harness)));
  await React.act(async () => latestUsage.openBillingPortal(() => refreshes++));
  assert.deepEqual(state.openedUrls, ["https://stripe.test/personal"]);
  state.authGeneration++;
  await React.act(async () => happyWindow.dispatchEvent(new happyWindow.Event("focus")));
  assert.equal(usageCalls, 1);
  assert.equal(refreshes, 0);
});

for (const departure of ["workspace", "revisit", "unmount"]) {
  for (const success of [true, false]) {
    test(`personal portal drops a delayed ${success ? "URL" : "failure"} after ${departure}`, async (t) => {
      const { happyWindow, state, root, useUsage, useBillingPortal } = await setup(t);
      happyWindow.electronAPI.cloudUsage = async () => ({
        success: true,
        plan: "pro",
        status: "active",
        isSubscribed: true,
      });
      let resolvePortal;
      happyWindow.electronAPI.cloudBillingPortal = () =>
        new Promise((resolve) => {
          resolvePortal = resolve;
        });
      let open;
      function Harness({ personal }) {
        open = useBillingPortal(useUsage(), personal).openBillingPortal;
        return null;
      }
      const show = (personal) =>
        React.act(async () => root.render(React.createElement(Harness, { personal })));
      await show(true);
      let pending;
      await React.act(async () => {
        pending = open();
      });
      if (departure === "unmount") await React.act(async () => root.render(null));
      else await show(false);
      if (departure === "revisit") await show(true);
      await React.act(async () => {
        resolvePortal({ success, url: "https://stripe.test/old-personal" });
        await pending;
      });
      assert.deepEqual(state.openedUrls, []);
      assert.deepEqual(state.toasts, []);
    });
  }
}

test("a new Personal visit can open its portal while the old URL is pending", async (t) => {
  const { happyWindow, state, root, useUsage, useBillingPortal } = await setup(t);
  const requests = [];
  let usageCalls = 0;
  let refreshes = 0;
  let portal;
  happyWindow.electronAPI.cloudUsage = async () => {
    usageCalls++;
    return { success: true, plan: "pro", status: "active", isSubscribed: true };
  };
  happyWindow.electronAPI.cloudBillingPortal = () =>
    new Promise((resolve) => requests.push(resolve));
  function Harness({ personal }) {
    portal = useBillingPortal(useUsage(), personal);
    return null;
  }
  const show = (personal) =>
    React.act(async () => root.render(React.createElement(Harness, { personal })));
  await show(true);
  await React.act(async () => {
    void portal.openBillingPortal();
  });
  await show(false);
  await show(true);
  assert.equal(portal.isOpening, false);
  await React.act(async () => {
    void portal.openBillingPortal(() => refreshes++);
  });
  assert.equal(requests.length, 2);
  await React.act(async () => requests.shift()({ success: true, url: "https://stripe.test/old" }));
  assert.deepEqual(state.openedUrls, []);
  assert.equal(portal.isOpening, true);
  await React.act(async () => requests.shift()({ success: true, url: "https://stripe.test/new" }));
  assert.deepEqual(state.openedUrls, ["https://stripe.test/new"]);
  assert.deepEqual(state.toasts, []);
  await show(false);
  await React.act(async () => happyWindow.dispatchEvent(new happyWindow.Event("focus")));
  assert.equal(refreshes, 0);
  assert.equal(usageCalls, 2);
});

test("a successful personal portal refreshes usage after Settings unmounts", async (t) => {
  const { happyWindow, root, useUsage, useBillingPortal } = await setup(t);
  let usageCalls = 0;
  let summaryCalls = 0;
  let open;
  happyWindow.electronAPI.cloudUsage = async () => {
    usageCalls++;
    return { success: true, plan: "pro", status: "active", isSubscribed: true };
  };
  happyWindow.electronAPI.cloudBillingPortal = async () => ({
    success: true,
    url: "https://stripe.test/personal",
  });
  function Harness() {
    open = useBillingPortal(useUsage()).openBillingPortal;
    return null;
  }
  await React.act(async () => root.render(React.createElement(Harness)));
  await React.act(async () => open(() => summaryCalls++));
  await React.act(async () => root.render(null));
  await React.act(async () => happyWindow.dispatchEvent(new happyWindow.Event("focus")));
  await React.act(async () => happyWindow.dispatchEvent(new happyWindow.Event("focus")));
  assert.equal(usageCalls, 2);
  assert.equal(summaryCalls, 0);
});

test("a failed browser launch reports the portal failure and ignores a later focus", async (t) => {
  const { happyWindow, state, root, useUsage, useBillingPortal } = await setup(t);
  let usageCalls = 0;
  let refreshes = 0;
  let openPortal;
  happyWindow.electronAPI.cloudUsage = async () => {
    usageCalls++;
    return { success: true, plan: "pro", status: "active", isSubscribed: true };
  };
  happyWindow.electronAPI.cloudBillingPortal = async () => ({
    success: true,
    url: "https://stripe.test/personal",
  });
  happyWindow.electronAPI.openExternal = async () => ({
    success: false,
    error: "No browser registered",
  });
  function Harness() {
    openPortal = useBillingPortal(useUsage()).openBillingPortal;
    return null;
  }
  await React.act(async () => root.render(React.createElement(Harness)));
  await React.act(async () => openPortal(() => refreshes++));
  assert.deepEqual(state.toasts, [
    {
      title: "settingsPage.account.billing.couldNotOpenTitle",
      description: "settingsPage.account.billing.couldNotOpenDescription",
      variant: "destructive",
    },
  ]);
  await React.act(async () => happyWindow.dispatchEvent(new happyWindow.Event("focus")));
  assert.equal(usageCalls, 1);
  assert.equal(refreshes, 0);
});
