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
const ADD_SEAT = "settingsPage.billing.addSeats.title";
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
    portal: async () => "https://stripe.test/portal",
    summaryCalls: [],
    summary: undefined,
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
      "/authRequestContext": `export const getValidatedAuthGeneration = () => globalThis.__gen ?? null;
         export const subscribeAuthRequestContext = () => () => {};`,
      "/services/BillingSummaryService": `export async function getBillingSummary(identity) {
        globalThis.__layoutTest.summaryCalls.push(identity.workspaceId);
        return globalThis.__layoutTest.summary;
      }`,
      "/stores/workspaceStore": `export const useWorkspaceStore = (select) => select({
        refresh: async () => {}
      });`,
      "/services/WorkspacesService": `export const WorkspacesService = {
        listMembers: async () => [],
        getPeopleCounts: async () => globalThis.__layoutTest.stats ?? {},
        previewSeats: (workspaceId, additionalSeats, authGeneration) => {
          globalThis.__layoutTest.previewCalls.push([workspaceId, additionalSeats, authGeneration]);
          return new Promise(() => {});
        },
        updateSeats: async () => { throw new Error("unexpected"); },
        billingPortal: async (workspaceId, generation) => {
          globalThis.__layoutTest.portalCalls.push([workspaceId, generation]);
          return globalThis.__layoutTest.portal();
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
      "/hooks/useBillingRefreshOnReturn": `export const useBillingRefreshOnReturn = (refresh) =>
        () => { globalThis.__layoutTest.refreshOnReturn = refresh; };`,
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
  assert.deepEqual(state.portalCalls, [["a", 7]]);
  assert.deepEqual(state.opened, ["https://stripe.test/portal"]);
});

test("owner cancelled: a remaining Stripe subscription is recovered through the portal", async (t) => {
  const { state, render, click } = await setup(t);
  await render(workspace({ status: "canceled" }));
  await click(RESUBSCRIBE);
  assert.deepEqual(state.portalCalls, [["a", 7]]);
  assert.deepEqual(state.checkoutCalls, []);
});

test("member: Managed account badge and workspace details, Copy email only", async (t) => {
  const { state, render, buttons, has, click } = await setup(t);
  await render(
    workspace({ role: "member", billing_manager: "Dana Lee", billing_manager_email: "Dana@X.co" })
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
  assert.deepEqual(state.copied, ["Dana@X.co"]);
  assert.equal(state.toasts.at(-1).title, "common.copied");
});

test("member without a manager email: no buttons at all", async (t) => {
  const { render, buttons, has } = await setup(t);
  for (const billing_manager_email of [undefined, null]) {
    await render(
      workspace({ role: "member", billing_manager: "display@x.co", billing_manager_email })
    );
    assert.equal(has("display@x.co"), true);
    assert.deepEqual(buttons(), []);
  }
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
  const reads = state.summaryCalls.length;
  await React.act(async () => dialog.onRefreshEntitlement());
  assert.equal(state.summaryCalls.length, reads + 1);
  await React.act(async () => dialog.onOpenChange(false));
  assert.equal(container.querySelector("[data-enterprise-dialog]") !== null, false);
});

test("cached workspace billing is read-only until the sign-in is validated", async (t) => {
  const { state, render, container, click, waitFor } = await setup(t);
  const current = workspace({ status: "past_due" });
  await render(workspace());
  await click(UPGRADE_ENTERPRISE);
  assert.equal(await waitFor(() => state.enterpriseDialogs.length > 0), true);
  globalThis.__gen = null;
  await render(current);
  const button = (label) =>
    [...container.querySelectorAll("button")].find((item) => item.textContent === label);
  assert.equal(container.querySelector("[data-enterprise-dialog]"), null);
  assert.equal(button(MANAGE_BILLING).disabled, true);
  assert.equal(button(UPDATE_PAYMENT).disabled, true);
  await click(UPDATE_PAYMENT);
  assert.deepEqual(state.portalCalls, []);

  await render(workspace({ role: "member", is_billable: false }), { onViewPersonal: () => {} });
  assert.equal(button(VIEW_PERSONAL).disabled, false);

  globalThis.__gen = 8;
  await render(current);
  assert.equal(button(UPDATE_PAYMENT).disabled, false);
  await click(UPDATE_PAYMENT);
  assert.deepEqual(state.portalCalls, [["a", 8]]);
});

test("Manage billing opens this workspace's portal", async (t) => {
  const { state, render, click } = await setup(t);
  await render(workspace());
  await click(MANAGE_BILLING);
  assert.deepEqual(state.portalCalls, [["a", 7]]);
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

test("seat meter hatches confirmed pending seats beside Add seats and hides a stale split", async (t) => {
  const { state, container, render } = await setup(t);
  // One nonbillable invitation and one SCIM reservation can produce identical counts.
  const paid = workspace({ seats: 10, seats_used: 8, member_count: 8, invitation_count: 1 });
  state.stats = { seats: 10, member_count: 8, billable_members: 7, pending_invitations: 1 };
  await render(paid);
  const addSeats = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === ADD_SEAT
  );
  assert.ok(addSeats.previousElementSibling.textContent.includes(`${W}.usage.pendingInvites`));
  const meter = addSeats.previousElementSibling.querySelector('[aria-hidden="true"]');
  assert.ok(
    addSeats.previousElementSibling.textContent.includes("settingsPage.billing.addSeats.inUse · 7")
  );
  assert.ok(
    addSeats.previousElementSibling.textContent.includes(
      "settingsPage.billing.addSeats.pending · 1"
    )
  );
  assert.deepEqual(
    [...meter.children].map((segment) => segment.style.width),
    ["70%", "10%"]
  );
  await render({ ...paid, invitation_count: 4 });
  assert.deepEqual(
    [...meter.children].map((segment) => segment.style.width),
    ["80%"]
  );
});

test("an unparseable period end never shows Invalid Date", async (t) => {
  const { render, text } = await setup(t);
  await render(workspace({ current_period_end: "not-a-date" }));
  assert.equal(text().includes("Invalid Date"), false);
});

test("paid owner capacity uses live invitation counts separately from the seat meter", async (t) => {
  const { render, has } = await setup(t);
  const full = workspace({ member_count: 6, seats_used: 7, seats: 7 });
  await render({ ...full, invitation_count: 3 });
  assert.equal(has(`${W}.usage.noSeatsLeftWithInvites`), true);
  await render({ ...full, invitation_count: 3, seats: 9 });
  assert.equal(has(`${W}.usage.pendingInvites`), true);
  for (const invitation_count of [undefined, 0]) {
    await render({ ...full, invitation_count });
    assert.equal(has(`${W}.usage.noSeatsLeftWithInvites`), false);
    assert.equal(has(`${W}.usage.noSeatsLeft`), true);
  }
});

test("owner billing details use the viewed workspace and disappear when its role changes", async (t) => {
  const { state, render, text, has, click } = await setup(t);
  state.summary = {
    cancel_at_period_end: true,
    interval: "annual",
    unit_amount: 24000,
    next_invoice: {
      date: new Date(2026, 11, 23, 12).toISOString(),
      amount: 72000,
      currency: "usd",
    },
    billing_email: "billing@example.test",
  };
  await render(workspace({ id: "viewed" }));
  assert.equal(has(`${W}.details.ends`), true);
  assert.equal(has(`${W}.details.firstInvoice`), false);
  assert.equal(has(`${W}.details.finalInvoice`), true);
  assert.equal(has("Dec 23, 2026 · $720.00"), true);
  assert.equal(has(`${W}.interval.annual`), true);
  assert.equal(has(`${W}.planLine.seatPrice`), true);
  assert.equal(text().includes("billing@example.test"), true);
  await click(`${W}.actions.keepPlan`);
  assert.deepEqual(state.portalCalls, [["viewed", 7]]);
  state.summary = { ...state.summary, cancel_at_period_end: false };
  await React.act(async () => state.refreshOnReturn());
  assert.equal(has(`${W}.details.ends`), false);
  assert.equal(has(`${W}.details.finalInvoice`), false);
  assert.equal(has(`${W}.details.nextInvoice`), true);
  assert.equal(has("$720.00"), true);
  await render(workspace({ id: "viewed", role: "member" }));
  assert.equal(has(`${W}.workspaceDetails`), true);
  assert.equal(has(`${W}.billingDetails`), false);
  assert.equal(text().includes("billing@example.test"), false);
  assert.deepEqual(state.summaryCalls, ["viewed", "viewed"]);
});

test("trial badge takes precedence over the billing interval when the seat price is known", async (t) => {
  const { state, render, has } = await setup(t);
  state.summary = {
    interval: "monthly",
    unit_amount: 1500,
    next_invoice: { date: "2026-12-20T00:00:00Z", amount: 4500, currency: "usd" },
  };
  await render(workspace({ status: "trialing" }));
  assert.equal(has(`${W}.badges.trialUndated`), true);
  assert.equal(has(`${W}.interval.monthly`), false);
  assert.equal(has(`${W}.planLine.seatPrice`), true);
  assert.equal(has(`${W}.details.firstInvoice`), true);
});

test("the active workspace interval uses the info badge", async (t) => {
  const { state, render, container } = await setup(t);
  state.summary = { interval: "annual" };
  await render(workspace());
  const interval = [...container.querySelectorAll("span")].find(
    (item) => item.textContent === `${W}.interval.annual`
  );
  assert.ok(interval?.classList.contains("text-primary"));
});

for (const scenario of ["workspace", "workspace round trip", "generation", "role", "role error"]) {
  test(`a late Keep Business portal result is discarded after changing ${scenario}`, async (t) => {
    const { state, render, click } = await setup(t);
    const owner = workspace({ cancel_at_period_end: true });
    const deferred = Promise.withResolvers();
    state.portal = () => deferred.promise;
    await render(owner);
    await click(`${W}.actions.keepPlan`);
    if (scenario.startsWith("workspace")) {
      await render({ ...owner, id: "other" });
      if (scenario.endsWith("trip")) await render(owner);
    } else if (scenario === "generation") {
      globalThis.__gen += 1;
      await render(owner);
    } else {
      await render({ ...owner, role: "member" });
    }
    await React.act(async () => {
      if (scenario === "role error") deferred.reject(new Error("old portal"));
      else deferred.resolve("https://stripe.test/old-portal");
    });
    assert.deepEqual(state.opened, []);
    assert.deepEqual(state.toasts, []);
    assert.equal(state.refreshOnReturn, undefined);
  });
}
