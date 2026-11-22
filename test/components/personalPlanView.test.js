const assert = require("node:assert/strict");
const test = require("node:test");
const React = require("react");
const { createRendererServer, installHappyDom } = require("../lib/rendererTestHarness");

const P = "settingsPage.billing.personal";
const PERIOD_END = "2026-12-20T00:00:00.000Z";

async function setup(t) {
  const cleanup = [];
  const context = { after: (callback) => cleanup.push(callback) };
  t.after(async () => {
    for (const callback of cleanup.reverse()) await callback();
  });
  const happyWindow = await installHappyDom(context);
  const vite = await createRendererServer(context, {
    noExternal: ["react-i18next"],
    cachePrefix: "openwhispr-personal-plan-view-",
    mockModules: {
      "/i18n": "export default { t: (key) => key };",
      "/settingsStore": "export const useSettingsStore = { getState: () => ({}) };",
      // Params are echoed so tests can see what reached t().
      "react-i18next": `export const useTranslation = () => ({
        t: (key, params) => (params ? key + JSON.stringify(params) : key),
        i18n: { language: "en" },
      });`,
      "/icons": ["User", "Zap", "Building2", "CreditCard", "Loader2", "ChevronDown"]
        .map((name) => `export const ${name} = () => null;`)
        .join("\n"),
    },
  });
  const { PersonalPlanView } = await vite.ssrLoadModule(
    "/components/settings/billing/PersonalPlanView.tsx"
  );
  const { createRoot } = require("react-dom/client");
  const container = happyWindow.document.createElement("div");
  const root = createRoot(container);
  context.after(() => React.act(() => root.unmount()));
  const actions = [];
  const render = (state, overrides = {}) =>
    React.act(async () =>
      root.render(
        React.createElement(PersonalPlanView, {
          state,
          onAction: (action) => actions.push(action),
          busyAction: null,
          grid: React.createElement("div", { "data-testid": "grid" }, "GRID"),
          formatDate: (iso) => `D(${iso.slice(0, 10)})`,
          ...overrides,
        })
      )
    );
  return { container, render, actions, vite };
}

const ready = (overrides = {}) => ({
  kind: "ready",
  tier: "free",
  showPlansGrid: true,
  badge: null,
  price: { key: "price.free" },
  actions: [],
  banners: [],
  usage: [],
  details: [],
  ...overrides,
});

const buttons = (container) => [...container.querySelectorAll("button")];
const findButton = (container, text) => buttons(container).find((b) => b.textContent === text);
const isPrimary = (button) => button.className.includes("text-primary-foreground");

test("free solo: Subscribe to Pro is the only primary button, words meter shown, no Billing Details", async (t) => {
  const { container, render } = await setup(t);
  await render(
    ready({
      actions: [
        { kind: "subscribePro" },
        { kind: "business", action: { kind: "createWorkspace" } },
      ],
      usage: [{ kind: "words", used: 100, limit: 2000, remaining: 1900, tone: "normal" }],
    })
  );
  const primaries = buttons(container).filter(isPrimary);
  assert.equal(primaries.length, 1);
  assert.equal(primaries[0].textContent, `${P}.actions.subscribePro`);
  assert.ok(findButton(container, "settingsPage.billing.tiles.createWorkspace"));
  assert.match(container.textContent, new RegExp(`${P}.usage.wordsValue`));
  assert.ok(container.querySelector('[style*="width"]'), "the meter rendered");
  assert.doesNotMatch(container.textContent, new RegExp(`${P}.blocks.billingDetails`));
  assert.ok(container.querySelector('[data-testid="grid"]'));
});

test("a covered member can use an enabled creator link without seeing the plans grid", async (t) => {
  const { container, render, vite } = await setup(t);
  const { default: CreatorLinkField } = await vite.ssrLoadModule(
    "/components/CreatorLinkField.tsx"
  );
  const { useAffiliateStore } = await vite.ssrLoadModule("/stores/affiliateStore.ts");
  const link = "https://creator.example.test/ref";
  useAffiliateStore.setState({ enabled: true, saved: false, link });
  await render(ready({ showPlansGrid: false, usage: [{ kind: "unlimited" }] }), {
    creatorLink: React.createElement(CreatorLinkField),
  });
  assert.match(container.textContent, /usage\.unlimited/);
  assert.equal(container.querySelector('[data-testid="grid"]'), null);
  assert.equal(container.querySelector("input").value, link);
  await React.act(async () => useAffiliateStore.setState({ saved: true }));
  assert.match(container.textContent, /affiliate\.saved/);
  await React.act(async () => useAffiliateStore.setState({ enabled: false }));
  assert.doesNotMatch(container.textContent, /affiliate\./);
});

test("covered + Stripe Pro: warning banner with Cancel Pro, which reports cancelPro", async (t) => {
  const { container, render, actions } = await setup(t);
  await render(
    ready({
      tier: "pro",
      badge: { key: "badges.monthly", tone: "info" },
      price: null,
      actions: [{ kind: "manageBilling" }],
      banners: [
        {
          id: "coveredPaying",
          tone: "warning",
          titleKey: "banners.coveredPaying.title",
          bodyKey: "banners.coveredPaying.body",
          params: { workspace: "Acme" },
          action: { kind: "cancelPro" },
        },
      ],
      usage: [{ kind: "unlimited" }],
      details: [{ labelKey: "details.periodEnds", value: { kind: "date", iso: PERIOD_END } }],
    })
  );
  assert.match(container.innerHTML, /bg-warning\/10/);
  assert.match(container.textContent, new RegExp(`${P}.banners.coveredPaying.title`));
  assert.match(container.textContent, /"workspace":"Acme"/);
  const cancel = findButton(container, `${P}.actions.cancelPro`);
  assert.ok(cancel);
  assert.equal(isPrimary(cancel), false);
  await React.act(async () => cancel.click());
  assert.deepEqual(actions, [{ kind: "cancelPro" }]);
  assert.equal(buttons(container).filter(isPrimary).length, 0);
  // Manage billing is secondary and dates are formatted before they reach t().
  assert.ok(findButton(container, `${P}.actions.manageBilling`));
  assert.match(container.textContent, /D\(2026-12-20\)/);
});

test("store App Store: Manage in App Store button and App Store in the details", async (t) => {
  const { container, render, actions } = await setup(t);
  await render(
    ready({
      tier: "pro",
      price: null,
      actions: [{ kind: "manageInStore", store: "app_store" }],
      usage: [{ kind: "unlimited" }],
      details: [
        { labelKey: "details.billedThrough", value: { kind: "storeName", store: "app_store" } },
        { labelKey: "details.periodEnds", value: { kind: "date", iso: PERIOD_END } },
      ],
    })
  );
  const manage = findButton(container, "settingsPage.account.billing.manageInAppStore");
  assert.ok(manage);
  await React.act(async () => manage.click());
  assert.deepEqual(actions, [{ kind: "manageInStore", store: "app_store" }]);
  assert.match(container.textContent, new RegExp(`${P}.blocks.billingDetails`));
  assert.match(container.textContent, new RegExp(`${P}.stores.appStore`));
  assert.match(container.textContent, /D\(2026-12-20\)/);
});

test("signed out: Sign in button and the grid slot", async (t) => {
  const { container, render, actions } = await setup(t);
  await render({ kind: "signedOut" });
  assert.match(container.textContent, new RegExp(`${P}.signedOut.title`));
  const signIn = findButton(container, "common.signIn");
  assert.ok(signIn);
  await React.act(async () => signIn.click());
  assert.deepEqual(actions, [{ kind: "signIn" }]);
  assert.ok(container.querySelector('[data-testid="grid"]'));
});

test("failed: Retry reports retry", async (t) => {
  const { container, render, actions } = await setup(t);
  await render({ kind: "failed" });
  assert.match(container.textContent, new RegExp(`${P}.failed.title`));
  const retry = findButton(container, "common.retry");
  await React.act(async () => retry.click());
  assert.deepEqual(actions, [{ kind: "retry" }]);
});

test("loading: skeletons, no buttons, and the wrapper says it is busy", async (t) => {
  const { container, render } = await setup(t);
  await render({ kind: "loading" });
  assert.equal(buttons(container).length, 0);
  assert.ok(container.querySelectorAll(".animate-pulse").length >= 3);
  assert.ok(container.querySelector('[aria-busy="true"]'));
});

test("a busy action spins its button", async (t) => {
  const { container, render } = await setup(t);
  await render(ready({ actions: [{ kind: "subscribePro" }] }), { busyAction: "subscribePro" });
  const button = findButton(container, `${P}.actions.subscribePro`);
  assert.equal(button.disabled, true);
  assert.equal(button.getAttribute("aria-busy"), "true");
});

test("a words row with no known limit is skipped, and the Usage block with it", async (t) => {
  const { container, render } = await setup(t);
  await render(
    ready({ usage: [{ kind: "words", used: 0, limit: 0, remaining: 0, tone: "normal" }] })
  );
  assert.doesNotMatch(container.textContent, new RegExp(`${P}.usage.wordsValue`));
  assert.doesNotMatch(container.textContent, new RegExp(`${P}.blocks.usage`));
});

test("no price from the model, no price line", async (t) => {
  const { container, render } = await setup(t);
  await render(ready({ tier: "business", price: null }));
  assert.doesNotMatch(container.textContent, /price\./);
  await render(ready({ tier: "pro", price: null }));
  assert.doesNotMatch(container.textContent, /price\./);
});

test("a destructive banner is an alert, any other a status", async (t) => {
  const { container, render } = await setup(t);
  await render(
    ready({
      banners: [
        { id: "paymentFailed", tone: "destructive", titleKey: "banners.paymentFailed.title" },
        { id: "weeklyLimit", tone: "warning", titleKey: "banners.weeklyLimit.title" },
      ],
    })
  );
  assert.equal(container.querySelectorAll('[role="alert"]').length, 1);
  assert.equal(container.querySelectorAll('[role="status"]').length, 1);
  assert.match(container.querySelector('[role="alert"]').textContent, /paymentFailed/);
});

test("while one portal action opens, every portal button is disabled and only it spins", async (t) => {
  const { container, render } = await setup(t);
  const state = ready({
    tier: "pro",
    actions: [{ kind: "manageBilling" }, { kind: "business", action: { kind: "createWorkspace" } }],
    banners: [
      {
        id: "coveredPaying",
        tone: "warning",
        titleKey: "banners.coveredPaying.title",
        action: { kind: "cancelPro" },
      },
    ],
  });
  await render(state, { busyAction: "cancelPro" });
  const cancel = findButton(container, `${P}.actions.cancelPro`);
  const manage = findButton(container, `${P}.actions.manageBilling`);
  const business = findButton(container, "settingsPage.billing.tiles.createWorkspace");
  assert.equal(cancel.disabled, true);
  assert.equal(cancel.getAttribute("aria-busy"), "true");
  assert.equal(manage.disabled, true);
  assert.equal(manage.getAttribute("aria-busy"), null);
  assert.equal(business.disabled, false);
  await render(state);
  assert.equal(findButton(container, `${P}.actions.manageBilling`).disabled, false);
});

test("a banner renders the body key the model chose", async (t) => {
  const { container, render } = await setup(t);
  await render(
    ready({
      tier: "pro",
      banners: [
        {
          id: "coveredPaying",
          tone: "warning",
          titleKey: "banners.coveredPayingUnnamed.title",
          bodyKey: "banners.coveredUnnamed.body",
          action: { kind: "cancelPro" },
        },
      ],
    })
  );
  assert.match(container.textContent, new RegExp(`${P}.banners.coveredPayingUnnamed.title`));
  assert.match(container.textContent, new RegExp(`${P}.banners.coveredUnnamed.body`));
  assert.doesNotMatch(container.textContent, /coveredPayingUnnamed\.body/);
});

test("a banner's date reaches t() formatted", async (t) => {
  const { container, render } = await setup(t);
  await render(
    ready({
      tier: "pro",
      banners: [
        {
          id: "coveredPaying",
          tone: "warning",
          titleKey: "banners.coveredPaying.title",
          bodyKey: "banners.coveredPaying.body",
          params: { workspace: "Acme", date: PERIOD_END },
        },
      ],
    })
  );
  assert.match(container.textContent, new RegExp(`${P}.banners.coveredPaying.body`));
  assert.match(container.textContent, /"date":"D\(2026-12-20\)"/);
});

test("the trial badge's day count reaches t() as a number, for its plural forms", async (t) => {
  const { container, render } = await setup(t);
  await render(
    ready({
      tier: "pro",
      badge: { key: "badges.trial", params: { days: "1" }, tone: "info" },
    })
  );
  assert.match(container.textContent, new RegExp(`${P}.badges.trial\\{[^}]*"count":1[,}]`));
});

test("scheduled Business cancellation renders the final invoice, balance and Keep Business", async (t) => {
  const { container, render, actions, vite } = await setup(t);
  const { personalPlanState } = await vite.ssrLoadModule("/lib/personalPlanState.ts");
  const input = {
    signedIn: true,
    now: Date.parse("2026-12-15T00:00:00Z"),
    usage: {
      status: "success",
      plan: "business",
      subscriptionStatus: "active",
      isSubscribed: true,
      isPersonallySubscribed: true,
      currentPeriodEnd: PERIOD_END,
      entitledWorkspaceIds: [],
    },
    coveringWorkspaceNames: [],
    businessAction: { kind: "none" },
    hasWorkspacePlanAction: false,
    summary: {
      cancel_at_period_end: true,
      next_invoice: {
        date: new Date(2026, 11, 23, 12).toISOString(),
        amount: 1875,
        currency: "usd",
      },
      outstanding_invoice: { next_payment_attempt: null, amount_remaining: 0, currency: "usd" },
      billing_email: "payer@example.test",
    },
  };
  await render(personalPlanState(input));
  assert.ok(container.textContent.includes(`${P}.details.ends`));
  assert.ok(container.textContent.includes(`${P}.details.finalInvoice`));
  assert.ok(container.textContent.includes("Dec 23, 2026 · $18.75"));
  assert.match(container.textContent, /\$0\.00/);
  assert.match(container.textContent, /payer@example\.test/);
  const keep = findButton(container, P + '.actions.keepPlan{"plan":"Business"}');
  assert.ok(keep);
  await React.act(async () => keep.click());
  assert.deepEqual(actions, [{ kind: "keepPlan", plan: "Business" }]);

  await render(
    personalPlanState({ ...input, summary: { ...input.summary, cancel_at_period_end: false } })
  );
  assert.ok(!container.textContent.includes(`${P}.details.finalInvoice`));
  assert.ok(container.textContent.includes(`${P}.details.nextInvoice`));
});
