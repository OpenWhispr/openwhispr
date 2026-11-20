const assert = require("node:assert/strict");
const test = require("node:test");
const React = require("react");
const { createRendererServer, installHappyDom } = require("../lib/rendererTestHarness");

const W = "settingsPage.billing.workspace";
const UPDATE_PAYMENT = `${W}.actions.updatePayment`;
const RESUBSCRIBE = `${W}.actions.resubscribe`;
const MANAGE_BILLING = `${W}.actions.manageBilling`;
const OPEN_CONSOLE = `${W}.actions.openConsole`;
const UPGRADE_ENTERPRISE = `${W}.actions.upgradeEnterprise`;
const COPY_EMAIL = `${W}.actions.copyEmail`;
const VIEW_PERSONAL = `${W}.actions.viewPersonal`;
const PAYMENT_BUTTONS = [
  UPDATE_PAYMENT,
  RESUBSCRIBE,
  MANAGE_BILLING,
  `${W}.actions.finishCheckout`,
];
const ADD_SEAT = "settingsPage.unifiedBilling.addSeat";
const MANAGED_ACCOUNT = `${W}.managedAccount`;

const workspace = (overrides = {}) => ({
  id: "a",
  name: "Acme",
  slug: "acme",
  created_by_user_id: "owner",
  stripe_customer_id: "cus_1",
  stripe_subscription_id: "sub_1",
  plan: "business",
  status: "active",
  trial_ends_at: null,
  current_period_end: "2026-12-20T00:00:00Z",
  cancel_at_period_end: false,
  seats: 5,
  seats_used: 3,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  role: "owner",
  is_billable: true,
  billing_manager: "Dana Lee",
  has_subscription: true,
  is_default: false,
  is_account_default: false,
  ...overrides,
});

async function setup(t) {
  const cleanup = [];
  const context = { after: (callback) => cleanup.push(callback) };
  t.after(async () => {
    for (const callback of cleanup.reverse()) await callback();
  });
  const happyWindow = await installHappyDom(context);
  const state = {
    portalCalls: [],
    checkoutCalls: [],
    previewCalls: [],
    consoleOpens: 0,
    opened: [],
    copied: [],
    toasts: [],
    enterpriseDialogs: [],
  };
  happyWindow.electronAPI = {
    openExternal: async (url) => state.opened.push(url),
    writeClipboard: async (text) => {
      state.copied.push(text);
      return { success: true };
    },
  };
  globalThis.__layoutTest = state;
  globalThis.__gen = 7;
  t.after(() => {
    delete globalThis.__layoutTest;
    delete globalThis.__gen;
  });
  const vite = await createRendererServer(context, {
    noExternal: ["react-i18next"],
    cachePrefix: "openwhispr-workspace-billing-card-layout-",
    mockModules: {
      "react-i18next":
        "export const useTranslation = () => ({ t: (key) => key, i18n: { language: 'en' } });",
      "/authRequestContext":
        "export const getValidatedAuthGeneration = () => globalThis.__gen ?? null;",
      "/stores/workspaceStore": `export const useWorkspaceStore = (select) => select({
        refresh: async () => {}
      });`,
      "/services/WorkspacesService": `export const WorkspacesService = {
        listMembers: async () => [],
        previewSeats: (workspaceId, additionalSeats, authGeneration) => {
          globalThis.__layoutTest.previewCalls.push([workspaceId, additionalSeats, authGeneration]);
          return new Promise(() => {});
        },
        updateSeats: async () => { throw new Error("unexpected"); },
        billingPortal: async (workspaceId) => {
          globalThis.__layoutTest.portalCalls.push(workspaceId);
          return "https://stripe.test/portal";
        },
        billingCheckout: async (...args) => {
          globalThis.__layoutTest.checkoutCalls.push(args);
          return "https://stripe.test/checkout";
        },
      };`,
      "/services/cloudApi": "export class CloudApiError extends Error {}",
      "/services/InvitationsService": "export const InvitationsService = { list: async () => [] };",
      "/lib/auth": `export const openAdminConsole = async () => {
        globalThis.__layoutTest.consoleOpens += 1;
      };`,
      "/EnterpriseCheckoutDialog": `import React from "react";
        export default function EnterpriseCheckoutDialog(props) {
          globalThis.__layoutTest.enterpriseDialogs.push(props);
          return React.createElement("div", { "data-enterprise-dialog": props.initialWorkspaceId });
        }`,
      "/ui/useToast":
        "export const useToast = () => ({ toast: (value) => globalThis.__layoutTest.toasts.push(value) });",
      "/hooks/useBillingRefreshOnReturn":
        "export const useBillingRefreshOnReturn = () => () => {};",
      "/ui/dialog": `import React from "react";
        const pass = ({ children }) => React.createElement("div", null, children);
        export const Dialog = ({ open, children }) =>
          open ? React.createElement("div", { role: "dialog" }, children) : null;
        export const DialogContent = pass;
        export const DialogDescription = pass;
        export const DialogFooter = pass;
        export const DialogHeader = pass;
        export const DialogTitle = pass;`,
      "../icons": `const icon = () => null;
        export const AudioLines = icon;
        export const Brain = icon;
        export const Code2 = icon;
        export const Key = icon;
        export const Link2 = icon;
        export const Mail = icon;
        export const MessageCircle = icon;
        export const MessageSquare = icon;
        export const MonitorSmartphone = icon;
        export const ShieldCheck = icon;
        export const Sliders = icon;
        export const Users = icon;
        export const Building2 = icon;
        export const Copy = icon;
        export const CreditCard = icon;
        export const ExternalLink = icon;
        export const Loader2 = icon;
        export const Plus = icon;
        export const Shield = icon;
        export const User = icon;
        export const UserPlus = icon;
        export const Zap = icon;`,
    },
  });
  const { createRoot } = require("react-dom/client");
  const container = happyWindow.document.createElement("div");
  happyWindow.document.body.appendChild(container);
  const root = createRoot(container);
  context.after(() => React.act(() => root.unmount()));
  const { default: WorkspaceBillingCard } = await vite.ssrLoadModule(
    "/components/settings/WorkspaceBillingCard.tsx"
  );
  const render = (value, props = {}) =>
    React.act(async () =>
      root.render(React.createElement(WorkspaceBillingCard, { workspace: value, ...props }))
    );
  // Strings only, so a failing assertion never has to print a happy-dom node.
  const buttons = () => [...container.querySelectorAll("button")].map((b) => b.textContent);
  const text = () => container.textContent;
  const has = (value) => container.textContent.includes(value);
  const click = (label) =>
    React.act(async () => {
      const button = [...container.querySelectorAll("button")].find(
        (candidate) => candidate.textContent === label
      );
      assert.ok(button, `Missing button ${label}`);
      button.click();
    });
  const waitFor = async (predicate) => {
    for (let attempt = 0; attempt < 50 && !predicate(); attempt += 1) {
      await React.act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    }
    return predicate();
  };
  return { state, container, render, buttons, text, has, click, waitFor };
}

test("owner past due: destructive banner whose Update payment opens this workspace's portal", async (t) => {
  const { state, render, has, click } = await setup(t);
  await render(workspace({ status: "past_due" }));
  assert.equal(has(`${W}.banners.paymentFailed.title`), true);
  assert.equal(has(`${W}.badges.pastDue`), true);
  await click(UPDATE_PAYMENT);
  assert.deepEqual(state.portalCalls, ["a"]);
  assert.deepEqual(state.opened, ["https://stripe.test/portal"]);
});

test("owner cancelled: Resubscribe starts a Business checkout", async (t) => {
  const { state, render, click } = await setup(t);
  await render(workspace({ status: "canceled" }));
  await click(RESUBSCRIBE);
  assert.deepEqual(state.checkoutCalls, [["a", "monthly", { tier: "business" }]]);
});

test("member: Managed account badge and workspace details, Copy email only", async (t) => {
  const { state, render, buttons, has, click } = await setup(t);
  await render(
    workspace({ role: "member", billing_manager: "Dana Lee", billing_manager_email: "dana@x.co" })
  );
  assert.equal(has(MANAGED_ACCOUNT), true);
  assert.equal(has(`${W}.workspaceDetails`), true);
  assert.equal(has(`${W}.details.yourRole`), true);
  assert.equal(has("settingsPage.workspace.role.member"), true);
  assert.equal(has(`${W}.details.yourSeat`), true);
  assert.equal(has(`${W}.details.paidSeat`), true);
  assert.equal(has(`${W}.details.managedBy`), true);
  assert.equal(has("Dana Lee"), true);
  assert.deepEqual(buttons(), [COPY_EMAIL]);
  await click(COPY_EMAIL);
  assert.deepEqual(state.copied, ["dana@x.co"]);
  assert.equal(state.toasts.at(-1).title, "common.copied");
});

test("member without a manager email: no buttons at all", async (t) => {
  const { render, buttons, has } = await setup(t);
  await render(workspace({ role: "member", billing_manager: "Dana Lee" }));
  assert.equal(has("Dana Lee"), true);
  assert.deepEqual(buttons(), []);
});

test("Enterprise admin: Open console opens the admin console", async (t) => {
  const { state, render, buttons, click } = await setup(t);
  await render(workspace({ role: "admin", plan: "enterprise" }));
  assert.deepEqual(buttons(), [OPEN_CONSOLE]);
  await click(OPEN_CONSOLE);
  assert.equal(state.consoleOpens, 1);
});

test("Stripe Business owner: Upgrade to Enterprise opens the dialog for this workspace", async (t) => {
  const { state, container, render, buttons, click, waitFor } = await setup(t);
  await render(workspace());
  assert.deepEqual(buttons(), [MANAGE_BILLING, UPGRADE_ENTERPRISE, ADD_SEAT]);
  await click(UPGRADE_ENTERPRISE);
  assert.equal(
    await waitFor(() => container.querySelector('[data-enterprise-dialog="a"]') !== null),
    true
  );
  const dialog = state.enterpriseDialogs.at(-1);
  assert.equal(dialog.initialWorkspaceId, "a");
  assert.deepEqual(
    dialog.workspaces.map((value) => value.id),
    ["a"]
  );
  await React.act(async () => dialog.onOpenChange(false));
  assert.equal(container.querySelector("[data-enterprise-dialog]") !== null, false);
});

test("Manage billing opens this workspace's portal", async (t) => {
  const { state, render, click } = await setup(t);
  await render(workspace());
  await click(MANAGE_BILLING);
  assert.deepEqual(state.portalCalls, ["a"]);
});

test("provisioned owner: invoiced by OpenWhispr, no Stripe buttons", async (t) => {
  const { render, buttons, has } = await setup(t);
  await render(workspace({ stripe_subscription_id: null, has_subscription: true }));
  assert.equal(has(`${W}.planLine.invoicedByOpenWhispr`), true);
  assert.equal(buttons().includes(MANAGE_BILLING), false);
  assert.equal(buttons().includes(ADD_SEAT), false);
  assert.equal(buttons().includes(UPGRADE_ENTERPRISE), false);
});

test("seats meter: Add seat asks for this workspace's bound quote", async (t) => {
  const { state, render, has, click } = await setup(t);
  await render(workspace({ seats: 5, seats_used: 5 }));
  assert.equal(has(`${W}.usage.seats`), true);
  assert.equal(has(`${W}.usage.noSeatsLeft`), true);
  await click(ADD_SEAT);
  assert.deepEqual(state.previewCalls, [["a", 1, 7]]);
});

test("the old Enterprise console row is gone: its action is the plan row's", async (t) => {
  const { render, text } = await setup(t);
  await render(workspace({ plan: "enterprise" }));
  assert.equal(text().includes("settingsPage.workspace.enterpriseConsole.title"), false);
});

for (const [label, status] of [
  ["past due", "past_due"],
  ["paused", "paused"],
]) {
  test(`${label} member: never a payment button, at most View personal plan`, async (t) => {
    const { render, buttons, has } = await setup(t);
    await render(workspace({ role: "member", status }), { onViewPersonal: () => {} });
    assert.equal(
      has(`${W}.banners.${status === "paused" ? "memberPaused" : "memberPaymentProblem"}.title`),
      true
    );
    for (const button of buttons()) {
      assert.equal(PAYMENT_BUTTONS.includes(button), false, `${button} is a payment button`);
      assert.equal(button, VIEW_PERSONAL);
    }
  });
}

test("provisioned owner past due: the payment failed banner offers no Update payment", async (t) => {
  const { render, buttons, has } = await setup(t);
  await render(
    workspace({ status: "past_due", stripe_subscription_id: null, has_subscription: true })
  );
  assert.equal(has(`${W}.banners.paymentFailed.title`), true);
  assert.equal(buttons().includes(UPDATE_PAYMENT), false);
  assert.equal(buttons().includes(MANAGE_BILLING), false);
  assert.equal(buttons().includes(ADD_SEAT), false);
});

test("seats meter: the count stays LTR-isolated", async (t) => {
  const { container, render } = await setup(t);
  await render(workspace({ seats: 5, seats_used: 3 }));
  const value = [...container.querySelectorAll('span[dir="ltr"]')].map((span) => span.textContent);
  assert.deepEqual(value, ["3 / 5"]);
});

test("an unparseable period end never shows Invalid Date", async (t) => {
  const { render, text } = await setup(t);
  await render(workspace({ current_period_end: "not-a-date" }));
  assert.equal(text().includes("Invalid Date"), false);
});
