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
    openExternal: async (url) => globalThis.__freeActionsTest.opened.push(url),
  };
  const state = {
    listMembersCalls: 0,
    listInvitationsCalls: 0,
    members: new Map(),
    invitations: new Map(),
    checkoutCalls: [],
    checkoutError: null,
    opened: [],
    toasts: [],
    inviteDialogs: [],
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
      "react-i18next": "export const useTranslation = () => ({ t: (key) => key });",
      "/authRequestContext":
        "export const getValidatedAuthGeneration = () => globalThis.__gen ?? null;",
      "/stores/workspaceStore": `export const useWorkspaceStore = (select) => select({
        refresh: async () => {}
      });`,
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
      "/ui/useToast":
        "export const useToast = () => ({ toast: (value) => globalThis.__freeActionsTest.toasts.push(value) });",
      "/hooks/useBillingRefreshOnReturn":
        "export const useBillingRefreshOnReturn = () => () => {};",
      "./EnterpriseConsoleRow": "export default function EnterpriseConsoleRow() { return null; }",
      "/ui/dialog": `import React from "react";
        const pass = ({ children }) => React.createElement("div", null, children);
        export const Dialog = ({ open, children }) =>
          open ? React.createElement("div", { role: "dialog" }, children) : null;
        export const DialogContent = pass;
        export const DialogDescription = pass;
        export const DialogFooter = pass;
        export const DialogHeader = pass;
        export const DialogTitle = pass;`,
      "../icons": `export const ExternalLink = () => null;
        export const Loader2 = () => null;
        export const Plus = () => null;
        export const UserPlus = () => null;`,
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
  // Labels and variants only, so a failing assertion never has to print a happy-dom node.
  const buttons = () =>
    [...container.querySelectorAll("button")].map((button) => ({
      label: button.textContent,
      variant: button.getAttribute("data-variant"),
    }));
  const click = (label) =>
    React.act(async () => {
      const button = [...container.querySelectorAll("button")].find(
        (candidate) => candidate.textContent === label
      );
      assert.ok(button, `Missing button ${label}`);
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
    click,
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
    { label: INVITE, variant: "default" },
    { label: UPGRADE, variant: "outline" },
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
  assert.deepEqual(buttons(), [{ label: UPGRADE, variant: "default" }]);
});

test("a failed count shows no primary and retries", async (t) => {
  const { state, buttons, click, render, settle, container } = await setup(t);
  await render(freeWorkspace("free-ws"));
  await settle(state.members, "free-ws", new Error("offline"));
  assert.equal(container.textContent.includes(COUNT_FAILED), true);
  assert.equal(
    buttons().some((button) => button.variant === "default"),
    false
  );
  assert.deepEqual(
    buttons().map((button) => button.label),
    [INVITE, UPGRADE, RETRY]
  );
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
  assert.deepEqual(buttons(), [{ label: UPGRADE, variant: "default" }]);
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

test("a subscribed or unbillable workspace asks for no count", async (t) => {
  const { state, render } = await setup(t);
  await render({ ...freeWorkspace("paid"), plan: "business", stripe_subscription_id: "sub" });
  await render({ ...freeWorkspace("member"), role: "member" });
  assert.equal(state.listMembersCalls, 0);
});
