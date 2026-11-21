const assert = require("node:assert/strict");
const test = require("node:test");
const React = require("react");
const { createRendererServer, installHappyDom } = require("../lib/rendererTestHarness");

const INVITE = "settingsPage.billing.free.inviteTeammates";
const UPGRADE = "settingsPage.billing.free.upgradeToBusiness";
const VIEW_PERSONAL = "settingsPage.billing.free.viewPersonal";
const COUNT_FAILED = "settingsPage.billing.free.countFailed";
const NO_TEAMMATES = "settingsPage.billing.errors.noTeammates";
const RETRY = "common.retry";
const MEMBERS = "settingsPage.billing.workspace.usage.members";

const freeWorkspace = (id) => ({
  id,
  name: `Workspace ${id}`,
  role: "owner",
  plan: "free",
  status: "active",
  stripe_subscription_id: null,
  has_subscription: false,
  seats: 1,
  seats_used: 1,
});

const member = (userId) => ({
  user_id: userId,
  role: "member",
  joined_at: "",
  email: "",
  name: null,
  image: null,
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

async function setup(t) {
  const cleanup = [];
  const context = { after: (callback) => cleanup.push(callback) };
  t.after(async () => {
    for (const callback of cleanup.reverse()) await callback();
  });
  const happyWindow = await installHappyDom(context);
  happyWindow.electronAPI = {
    openExternal: async (url) => {
      const state = globalThis.__freeActionsTest;
      if (state.openError) throw state.openError;
      state.opened.push(url);
      return state.openResult;
    },
  };
  const state = {
    listMembersCalls: 0,
    listInvitationsCalls: 0,
    members: new Map(),
    invitations: new Map(),
    checkoutCalls: [],
    checkoutError: null,
    openError: null,
    opened: [],
    toasts: [],
    inviteDialogs: [],
    enterpriseDialogs: [],
  };
  const pending = (map, workspaceId) => {
    const request = deferred();
    if (!map.has(workspaceId)) map.set(workspaceId, []);
    map.get(workspaceId).push(request);
    return request.promise;
  };
  state.pending = pending;
  globalThis.__freeActionsTest = state;
  globalThis.__gen = 7;
  t.after(() => {
    delete globalThis.__freeActionsTest;
    delete globalThis.__gen;
  });
  const vite = await createRendererServer(context, {
    noExternal: ["react-i18next"],
    cachePrefix: "openwhispr-workspace-billing-free-actions-",
    mockModules: {
      "react-i18next":
        "export const useTranslation = () => ({ t: (key) => key, i18n: { language: 'en' } });",
      "/authRequestContext": `export const getValidatedAuthGeneration = () => globalThis.__gen ?? null;
         export const subscribeAuthRequestContext = () => () => {};`,
      "/stores/workspaceStore": `export const useWorkspaceStore = (select) => select({
        refresh: async () => {}
      });`,
      "/services/BillingSummaryService": "export const getBillingSummary = async () => undefined;",
      "/services/cloudApi": `export class CloudApiError extends Error {
        constructor(message, status, code) {
          super(message);
          this.status = status;
          this.code = code;
        }
      }`,
      "/services/WorkspacesService": `export const WorkspacesService = {
        listMembers: (workspaceId) => {
          const state = globalThis.__freeActionsTest;
          state.listMembersCalls += 1;
          return state.pending(state.members, workspaceId);
        },
        previewSeats: async () => { throw new Error("unexpected"); },
        updateSeats: async () => { throw new Error("unexpected"); },
        billingPortal: async () => "https://stripe.test/portal",
        billingCheckout: async (...args) => {
          const state = globalThis.__freeActionsTest;
          state.checkoutCalls.push(args);
          if (state.checkoutError) throw state.checkoutError;
          return "https://stripe.test/checkout";
        },
      };`,
      "/services/InvitationsService": `export const InvitationsService = {
        list: (workspaceId) => {
          const state = globalThis.__freeActionsTest;
          state.listInvitationsCalls += 1;
          return state.pending(state.invitations, workspaceId);
        },
      };`,
      "/InviteTeammateDialog": `import React from "react";
        export default function InviteTeammateDialog(props) {
          globalThis.__freeActionsTest.inviteDialogs.push(props);
          return React.createElement("div", { "data-invite-dialog": props.workspaceId });
        }`,
      "/EnterpriseCheckoutDialog": `import React from "react";
        export default function EnterpriseCheckoutDialog(props) {
          globalThis.__freeActionsTest.enterpriseDialogs.push(props);
          return React.createElement("div", { "data-enterprise-dialog": props.initialWorkspaceId });
        }`,
      "/ui/useToast":
        "export const useToast = () => ({ toast: (value) => globalThis.__freeActionsTest.toasts.push(value) });",
      "/hooks/useBillingRefreshOnReturn":
        "export const useBillingRefreshOnReturn = () => () => {};",
      // The real module starts the auth client; the card only calls openAdminConsole.
      "/lib/auth": "export const openAdminConsole = async () => {};",
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
  const { CloudApiError } = await vite.ssrLoadModule("/services/cloudApi");
  const { createRoot } = require("react-dom/client");
  const container = happyWindow.document.createElement("div");
  happyWindow.document.body.appendChild(container);
  const root = createRoot(container);
  context.after(() => React.act(() => root.unmount()));
  const { default: WorkspaceBillingCard } = await vite.ssrLoadModule(
    "/components/settings/WorkspaceBillingCard.tsx"
  );
  const render = (workspace, props = {}) =>
    React.act(async () =>
      root.render(React.createElement(WorkspaceBillingCard, { workspace, ...props }))
    );
  // The card's own buttons; the Plans grid below it is read through gridButtons.
  const cardButtonElements = () =>
    [...container.querySelectorAll("button")].filter(
      (button) => !button.closest("[data-plans-grid]")
    );
  // Labels and variants only, so a failing assertion never has to print a happy-dom node.
  const buttons = () =>
    cardButtonElements().map((button) => ({
      label: button.textContent,
      variant: button.getAttribute("data-variant"),
    }));
  const gridButtonElements = (plan) => [
    ...container.querySelectorAll(`[data-plans-grid] [data-plan="${plan}"] button`),
  ];
  const gridButtons = (plan) =>
    gridButtonElements(plan).map((button) => ({
      label: button.textContent,
      variant: button.getAttribute("data-variant"),
    }));
  const hasGrid = () => container.querySelector("[data-plans-grid]") !== null;
  // The Members row's value, or null when the row isn't there.
  const membersValue = () => {
    const label = [...container.querySelectorAll("span")].find(
      (span) => span.textContent === MEMBERS
    );
    return label ? label.nextElementSibling.textContent : null;
  };
  const membersIsolated = () =>
    [...container.querySelectorAll("bdi")].map((node) => node.textContent);
  const click = (label) =>
    React.act(async () => {
      const button = cardButtonElements().find((candidate) => candidate.textContent === label);
      assert.ok(button, `Missing button ${label}`);
      button.click();
    });
  const clickGrid = (plan, label) =>
    React.act(async () => {
      const button = gridButtonElements(plan).find((candidate) => candidate.textContent === label);
      assert.ok(button, `Missing ${plan} grid button ${label}`);
      button.click();
    });
  const settle = (map, workspaceId, outcome) =>
    React.act(async () => {
      const request = map.get(workspaceId).shift();
      if (outcome instanceof Error) request.reject(outcome);
      else request.resolve(outcome);
    });
  const resolveCount = async (workspaceId, members, invitations = []) => {
    await settle(state.members, workspaceId, members);
    await settle(state.invitations, workspaceId, invitations);
  };
  // The invite dialog is lazy: its module arrives a few turns after the click.
  const waitFor = async (predicate) => {
    for (let attempt = 0; attempt < 50 && !predicate(); attempt += 1) {
      await React.act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    }
    return predicate();
  };
  return {
    state,
    container,
    render,
    buttons,
    gridButtons,
    hasGrid,
    membersValue,
    membersIsolated,
    click,
    clickGrid,
    settle,
    resolveCount,
    waitFor,
    CloudApiError,
  };
}

test("no button shows until the people count arrives", async (t) => {
  const { state, buttons, render } = await setup(t);
  await render(freeWorkspace("free-ws"));
  assert.equal(state.listMembersCalls, 1);
  assert.equal(state.listInvitationsCalls, 1);
  assert.equal(buttons().length, 0);
});

test("a solo workspace shows Invite first; Upgrade sends tier business", async (t) => {
  const { state, buttons, click, render, resolveCount, container } = await setup(t);
  await render(freeWorkspace("free-ws"));
  await resolveCount("free-ws", [member("owner")], []);
  assert.deepEqual(buttons(), [
    { label: INVITE, variant: "primary" },
    { label: UPGRADE, variant: "secondary" },
  ]);
  // The hint shows; its link only once someone can take it.
  assert.equal(container.textContent.includes("settingsPage.billing.free.proHint"), true);
  await click(UPGRADE);
  assert.deepEqual(state.checkoutCalls, [["free-ws", "monthly", { tier: "business" }]]);
  assert.deepEqual(state.opened, ["https://stripe.test/checkout"]);
});

test("the View Personal plan link shows when the card is given somewhere to go", async (t) => {
  const { buttons, click, render, resolveCount } = await setup(t);
  let viewed = 0;
  await render(freeWorkspace("free-ws"), { onViewPersonal: () => (viewed += 1) });
  await resolveCount("free-ws", [member("owner")], []);
  assert.deepEqual(
    buttons().map((button) => button.label),
    [INVITE, UPGRADE, VIEW_PERSONAL]
  );
  await click(VIEW_PERSONAL);
  assert.equal(viewed, 1);
});

test("Invite opens the dialog, and a sent invitation counts again", async (t) => {
  const { state, click, render, resolveCount, container, waitFor } = await setup(t);
  await render(freeWorkspace("free-ws"));
  await resolveCount("free-ws", [member("owner")], []);
  await click(INVITE);
  assert.equal(
    await waitFor(() => container.querySelector('[data-invite-dialog="free-ws"]') !== null),
    true
  );
  const dialog = state.inviteDialogs.at(-1);
  assert.equal(dialog.workspaceName, "Workspace free-ws");
  await React.act(async () => dialog.onInvitationsChanged());
  assert.equal(state.listMembersCalls, 2);
  assert.equal(state.listInvitationsCalls, 2);
});

test("two or more people lead with Upgrade alone", async (t) => {
  const { buttons, render, resolveCount } = await setup(t);
  await render(freeWorkspace("free-ws"));
  await resolveCount(
    "free-ws",
    [member("owner")],
    [{ accepted_at: null, revoked_at: null, expires_at: "2999-01-01T00:00:00Z" }]
  );
  assert.deepEqual(buttons(), [{ label: UPGRADE, variant: "primary" }]);
});

test("a failed count shows no primary and retries", async (t) => {
  const { state, buttons, click, render, settle, container } = await setup(t);
  await render(freeWorkspace("free-ws"));
  await settle(state.members, "free-ws", new Error("offline"));
  assert.equal(container.textContent.includes(COUNT_FAILED), true);
  assert.equal(
    buttons().some((button) => button.variant === "primary"),
    false
  );
  assert.deepEqual(buttons(), [
    { label: INVITE, variant: "secondary" },
    { label: UPGRADE, variant: "secondary" },
    { label: RETRY, variant: null },
  ]);
  await click(RETRY);
  assert.equal(state.listMembersCalls, 2);
  assert.equal(buttons().length, 0);
});

test("a people count for A never decides B's buttons", async (t) => {
  const { state, buttons, render, resolveCount } = await setup(t);
  await render(freeWorkspace("a"));
  await render(freeWorkspace("b"));
  await resolveCount("a", [member("owner")], []);
  assert.equal(buttons().length, 0);
  await resolveCount("b", [member("owner"), member("other")], []);
  assert.deepEqual(buttons(), [{ label: UPGRADE, variant: "primary" }]);
  assert.equal(state.listMembersCalls, 2);
});

test("a count that returns after the sign-in changed is dropped", async (t) => {
  const { state, buttons, render, resolveCount } = await setup(t);
  await render(freeWorkspace("a"));
  globalThis.__gen = 8;
  await resolveCount("a", [member("owner")], []);
  assert.equal(buttons().length, 0);
  // The next render sees the new sign-in and counts again for it.
  await render(freeWorkspace("a"));
  assert.equal(state.listMembersCalls, 2);
  await resolveCount("a", [member("owner")], []);
  assert.equal(buttons()[0].label, INVITE);
});

test("a refused checkout for a workspace with no teammates says why", async (t) => {
  const { state, click, render, resolveCount, CloudApiError } = await setup(t);
  state.checkoutError = new CloudApiError("raw", 409, "default_workspace_has_no_teammates");
  await render(freeWorkspace("free-ws"));
  await resolveCount("free-ws", [member("owner")], []);
  await click(UPGRADE);
  assert.equal(state.toasts.at(-1).description, NO_TEAMMATES);
});

test("a free workspace admin reads the people count for the Members row", async (t) => {
  const { state, buttons, render, settle, membersValue, membersIsolated } = await setup(t);
  await render({ ...freeWorkspace("free-ws"), role: "admin" });
  assert.equal(state.listMembersCalls, 1);
  assert.equal(state.listInvitationsCalls, 0);
  assert.equal(membersValue(), "—", "while counting");
  await settle(state.members, "free-ws", [member("owner"), member("admin")]);
  assert.equal(membersValue(), "2");
  assert.deepEqual(membersIsolated(), ["2"]);
  // An admin can't buy: still no free-workspace buttons.
  assert.deepEqual(buttons(), []);
});

test("a Members count that failed drops the row and the Usage block", async (t) => {
  const { state, container, render, settle, membersValue } = await setup(t);
  await render({ ...freeWorkspace("free-ws"), role: "admin" });
  await settle(state.members, "free-ws", new Error("offline"));
  assert.equal(membersValue(), null);
  assert.equal(container.textContent.includes("settingsPage.billing.personal.blocks.usage"), false);
});

test("a subscribed or unbillable workspace asks for no count", async (t) => {
  const { state, render } = await setup(t);
  await render({ ...freeWorkspace("paid"), plan: "business", stripe_subscription_id: "sub" });
  await render({ ...freeWorkspace("member"), role: "member" });
  assert.equal(state.listMembersCalls, 0);
});

const ENTERPRISE_UPGRADE = "settingsPage.account.pricing.enterprise.upgradeCta";
const CONTACT_SALES = "settingsPage.account.pricing.enterprise.cta";

test("the plans grid under a free workspace shows Business and Enterprise only", async (t) => {
  const { container, hasGrid, render, resolveCount } = await setup(t);
  await render(freeWorkspace("free-ws"));
  await resolveCount("free-ws", [member("owner")], []);
  assert.equal(hasGrid(), true);
  const plans = [...container.querySelectorAll("[data-plans-grid] [data-plan]")].map((node) =>
    node.getAttribute("data-plan")
  );
  assert.deepEqual(plans, ["business", "enterprise"]);
});

test("the grid's Business is always secondary: the card's own button leads", async (t) => {
  const { state, buttons, gridButtons, render, resolveCount, settle } = await setup(t);
  const businessVariants = () => gridButtons("business").map((button) => button.variant);
  await render(freeWorkspace("free-ws"));
  assert.deepEqual(businessVariants(), ["secondary"], "while counting");
  await resolveCount("free-ws", [member("owner")], []);
  assert.deepEqual(businessVariants(), ["secondary"], "solo");

  await render(freeWorkspace("pair"));
  await resolveCount(
    "pair",
    [member("owner")],
    [{ accepted_at: null, revoked_at: null, expires_at: "2999-01-01T00:00:00Z" }]
  );
  // The card's Upgrade is the one primary Upgrade to Business.
  assert.deepEqual(buttons(), [{ label: UPGRADE, variant: "primary" }]);
  assert.deepEqual(businessVariants(), ["secondary"], "two people");

  await render(freeWorkspace("offline"));
  await settle(state.members, "offline", new Error("offline"));
  assert.deepEqual(businessVariants(), ["secondary"], "failed count");
});

test("the grid's Business starts the tier-named Business checkout for this workspace", async (t) => {
  const { state, clickGrid, render, resolveCount } = await setup(t);
  await render(freeWorkspace("free-ws"));
  await resolveCount("free-ws", [member("owner"), member("other")], []);
  await clickGrid("business", UPGRADE);
  assert.deepEqual(state.checkoutCalls, [["free-ws", "monthly", { tier: "business" }]]);
  assert.deepEqual(state.opened, ["https://stripe.test/checkout"]);
});

for (const plan of ["pro", "enterprise", "business"]) {
  test(`a lapsed ${plan} workspace buys Business with its selected cadence`, async (t) => {
    const { state, clickGrid, render } = await setup(t);
    const former = { ...freeWorkspace("former"), plan, status: "canceled" };
    for (const yearly of [true, false]) {
      await render(former, { yearly, onYearlyChange: () => {} });
      await clickGrid("business", UPGRADE);
    }
    assert.deepEqual(state.checkoutCalls, [
      ["former", "annual", { tier: "business" }],
      ["former", "monthly", { tier: "business" }],
    ]);
  });
}

test("a failed external launch reports the payment error and permits retry", async (t) => {
  const { state, render, clickGrid } = await setup(t);
  await render({ ...freeWorkspace("solo"), member_count: 1, invitation_count: 0 });
  state.openResult = { success: false, error: "Browser unavailable" };
  await clickGrid("business", UPGRADE);
  assert.equal(state.toasts.at(-1).description, "Browser unavailable");
  state.openResult = { success: true };
  await clickGrid("business", UPGRADE);
  assert.equal(state.checkoutCalls.length, 2);
});

test("the grid's Enterprise opens the checkout dialog preselected on this workspace", async (t) => {
  const { state, clickGrid, render, resolveCount, container, waitFor } = await setup(t);
  await render(freeWorkspace("free-ws"), { yearly: true, onYearlyChange: () => {} });
  await resolveCount("free-ws", [member("owner")], []);
  await clickGrid("enterprise", ENTERPRISE_UPGRADE);
  assert.equal(
    await waitFor(() => container.querySelector('[data-enterprise-dialog="free-ws"]') !== null),
    true
  );
  const dialog = state.enterpriseDialogs.at(-1);
  assert.equal(dialog.initialWorkspaceId, "free-ws");
  assert.equal(dialog.initialBillingInterval, "annual");
  assert.deepEqual(
    dialog.workspaces.map((workspace) => workspace.id),
    ["free-ws"]
  );
  assert.deepEqual(state.checkoutCalls, []);
});

test("a free workspace that can't check out offers no Business button and contacts sales for Enterprise", async (t) => {
  const { state, gridButtons, clickGrid, render } = await setup(t);
  await render({ ...freeWorkspace("flagged"), has_subscription: true });
  // The checkout would be refused, so Business offers no button, as on the card.
  assert.deepEqual(gridButtons("business"), []);
  assert.deepEqual(
    gridButtons("enterprise").map((button) => button.label),
    [CONTACT_SALES]
  );
  await clickGrid("enterprise", CONTACT_SALES);
  assert.deepEqual(state.opened, ["https://openwhispr.com/contact-sales"]);
  assert.deepEqual(state.enterpriseDialogs, []);
});

test("members and paid workspaces get no plans grid", async (t) => {
  const { hasGrid, render } = await setup(t);
  await render({ ...freeWorkspace("member"), role: "member" });
  assert.equal(hasGrid(), false);
  await render({ ...freeWorkspace("paid"), plan: "business", stripe_subscription_id: "sub" });
  assert.equal(hasGrid(), false);
});

test("a contact-sales page that won't open says so", async (t) => {
  const { state, clickGrid, render } = await setup(t);
  state.openError = new Error("no browser");
  await render({ ...freeWorkspace("flagged"), has_subscription: true });
  await clickGrid("enterprise", CONTACT_SALES);
  await React.act(() => new Promise((resolve) => setTimeout(resolve, 0)));
  assert.equal(state.toasts.at(-1)?.description, "no browser");
  assert.equal(state.toasts.at(-1)?.variant, "destructive");
});

test("complete list counts give a free owner or admin the Members row with no roster reads", async (t) => {
  const { state, buttons, render, membersValue } = await setup(t);
  await render({ ...freeWorkspace("a"), member_count: 0, invitation_count: 1 });
  assert.equal(membersValue(), "0");
  assert.equal(buttons()[0].label, INVITE);
  await render({ ...freeWorkspace("a"), role: "admin", member_count: 2 });
  assert.equal(membersValue(), "2");
  assert.deepEqual(buttons(), []);
  assert.equal(state.listMembersCalls, 0);
  assert.equal(state.listInvitationsCalls, 0);
});

test("two known members show Upgrade without loading invitations", async (t) => {
  const { state, buttons, render, membersValue } = await setup(t);
  await render({ ...freeWorkspace("a"), member_count: 2 });
  assert.equal(membersValue(), "2");
  assert.deepEqual(buttons(), [{ label: UPGRADE, variant: "primary" }]);
  assert.equal(state.listMembersCalls, 0);
  assert.equal(state.listInvitationsCalls, 0);
});

test("two known invites show Upgrade even when the separate Members row fails", async (t) => {
  const { state, buttons, render, settle, membersValue } = await setup(t);
  await render({ ...freeWorkspace("a"), invitation_count: 2 });
  assert.deepEqual(buttons(), [{ label: UPGRADE, variant: "primary" }]);
  assert.equal(state.listMembersCalls, 1);
  assert.equal(state.listInvitationsCalls, 0);
  await settle(state.members, "a", new Error("offline"));
  assert.equal(membersValue(), null);
  assert.deepEqual(buttons(), [{ label: UPGRADE, variant: "primary" }]);
});

test("a supplied owner member count renders while only missing invitations load and retry", async (t) => {
  const { state, buttons, render, settle, click, membersValue } = await setup(t);
  await render({ ...freeWorkspace("a"), member_count: 1 });
  assert.equal(state.listMembersCalls, 0);
  assert.equal(state.listInvitationsCalls, 1);
  assert.equal(membersValue(), "1");
  assert.deepEqual(buttons(), []);
  await settle(state.invitations, "a", new Error("offline"));
  assert.equal(membersValue(), "1");
  await click(RETRY);
  assert.deepEqual(buttons(), []);
  await settle(state.invitations, "a", [
    { accepted_at: null, revoked_at: null, expires_at: "2999-01-01T00:00:00Z" },
  ]);
  assert.deepEqual(buttons(), [{ label: UPGRADE, variant: "primary" }]);
  assert.equal(state.listMembersCalls, 0);
  assert.equal(state.listInvitationsCalls, 2);
});

test("a supplied invitation count uses only members and ignores a stale roster after an identity change", async (t) => {
  const { state, buttons, render, settle, membersValue } = await setup(t);
  await render({ ...freeWorkspace("a"), invitation_count: 0 });
  globalThis.__gen = 8;
  await render({ ...freeWorkspace("a"), invitation_count: 0 });
  await settle(state.members, "a", [member("old-owner")]);
  assert.deepEqual(buttons(), []);
  assert.equal(membersValue(), "—");
  await settle(state.members, "a", [member("owner"), { ...member("admin"), is_billable: false }]);
  assert.equal(membersValue(), "2");
  assert.deepEqual(buttons(), [{ label: UPGRADE, variant: "primary" }]);
  assert.equal(state.listMembersCalls, 2);
  assert.equal(state.listInvitationsCalls, 0);
});

test("a returned member roster renders while the free owner still waits for invitations", async (t) => {
  const { state, buttons, render, settle, membersValue } = await setup(t);
  await render(freeWorkspace("a"));
  await settle(state.members, "a", [member("owner")]);
  assert.equal(membersValue(), "1");
  assert.deepEqual(buttons(), []);
});

test("a canceled paid workspace with legacy counts requests no people rosters", async (t) => {
  const { state, render, membersValue } = await setup(t);
  await render({ ...freeWorkspace("a"), plan: "business", status: "canceled" });
  assert.equal(membersValue(), null);
  assert.equal(state.listMembersCalls, 0);
  assert.equal(state.listInvitationsCalls, 0);
});
