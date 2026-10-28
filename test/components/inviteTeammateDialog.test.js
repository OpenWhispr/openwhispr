const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHostDom,
} = require("../lib/rendererTestHarness");

async function mountDialog(t, props) {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    for (const key of [
      "__viewProps",
      "__sendCalls",
      "__seatPreview",
      "__sendGate",
      "__previewCalls",
      "__workspaces",
      "__sendOutcome",
      "__refreshCalls",
    ]) {
      delete globalThis[key];
    }
  });
  installBrowserGlobals(t, {
    window: {
      electronAPI: { searchInviteContacts: async () => ({ success: true, contacts: [] }) },
    },
  });
  const container = installHostDom(t);
  globalThis.__sendCalls = [];
  globalThis.__previewCalls = [];
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-invite-teammate-dialog-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `
        export function useTranslation() {
          return { t: (key, params) => (params ? key + "|" + JSON.stringify(params) : key) };
        }
      `,
      "/ui/dialog": `
        import React from "react";
        export const Dialog = ({ children }) => React.createElement("div", null, children);
      `,
      // Records every render's props, so the test can read the state and press Send.
      "/InvitePeopleView": `
        export function InvitePeopleView(props) {
          (globalThis.__viewProps ??= []).push(props);
          return null;
        }
      `,
      "/services/invitePeople": `
        export const invitePeople = {
          async sendInvitations(input) {
            globalThis.__sendCalls.push(input);
            if (globalThis.__sendGate) await globalThis.__sendGate;
            for (const email of input.emails) {
              input.onResult(email, globalThis.__sendOutcome ?? { ok: true, emailSent: true });
            }
          },
        };
      `,
      "/stores/workspaceStore": `
        export const useWorkspaceStore = (selector) =>
          selector({ workspaces: globalThis.__workspaces ?? [] });
        useWorkspaceStore.getState = () => ({
          refresh: async (options) => {
            (globalThis.__refreshCalls ??= []).push(options);
          },
        });
      `,
      "/services/WorkspacesService": `
        export const WorkspacesService = {
          // Prices each added seat at the opening preview's amount.
          previewSeats: (workspaceId, seats) => {
            globalThis.__previewCalls.push(seats);
            return globalThis.__seatPreview
              ? Promise.resolve({
                  ...globalThis.__seatPreview,
                  amount_due: globalThis.__seatPreview.amount_due * seats,
                })
              : Promise.reject(new Error("no subscription"));
          },
          listMembers: async () => [],
        };
      `,
    },
  });
  const { default: InviteTeammateDialog } = await vite.ssrLoadModule(
    "/components/InviteTeammateDialog.tsx"
  );
  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(InviteTeammateDialog, props)));
  return {
    latest: () => globalThis.__viewProps.at(-1),
    unmount: async () => {
      await React.act(async () => root.unmount());
      root = null;
    },
  };
}

test("existing callers keep their props", async (t) => {
  const invited = [];
  const { latest } = await mountDialog(t, {
    open: true,
    onOpenChange: () => {},
    workspaceId: "w1",
    workspaceName: "Acme",
    teamIds: ["t1"],
    initialEmail: "a@x.com",
    cancelLabel: "Skip",
    onInvited: (email) => invited.push(email),
  });

  const first = globalThis.__viewProps[0];
  assert.deepEqual(
    first.state.recipients.map((recipient) => recipient.email),
    ["a@x.com"]
  );
  assert.equal(first.cancelLabel, "Skip");
  assert.equal(first.workspaceName, "Acme");

  await React.act(async () => latest().onSend());

  assert.equal(globalThis.__sendCalls.length, 1);
  const [call] = globalThis.__sendCalls;
  assert.equal(call.workspaceId, "w1");
  assert.deepEqual(call.emails, ["a@x.com"]);
  assert.deepEqual(call.teamIds, ["t1"]);
  assert.equal(call.role, "member");
  assert.deepEqual(invited, [["a@x.com"]]);
  assert.equal(latest().state.phase, "done");
  assert.deepEqual(
    latest().state.sent.map((entry) => entry.email),
    ["a@x.com"]
  );
});

test("knownEmails blocks an address already in the workspace", async (t) => {
  const { latest } = await mountDialog(t, {
    open: true,
    onOpenChange: () => {},
    workspaceId: "w1",
    workspaceName: "Acme",
    initialEmail: "Mia@X.com",
    knownEmails: { members: ["mia@x.com"], invited: [] },
  });

  assert.deepEqual(latest().state.recipients, [
    { email: "mia@x.com", state: { status: "blocked", reason: "alreadyMember" } },
  ]);
});

test("several addresses show the seats they add, priced by their own preview", async (t) => {
  globalThis.__seatPreview = {
    seats_used: 5,
    current_quantity: 5,
    amount_due: 1200,
    currency: "usd",
  };
  const { latest } = await mountDialog(t, {
    open: true,
    onOpenChange: () => {},
    workspaceId: "w1",
    workspaceName: "Acme",
    initialEmail: "a@x.com",
  });
  await React.act(async () => {});

  assert.match(latest().seatCostLine, /^workspaces\.invite\.seatCost\|/);

  await React.act(async () => latest().dispatch({ type: "draft", text: "b@x.com," }));
  // Never silent while the price for two seats is on its way.
  assert.equal(latest().seatCostLine, 'workspaces.invite.seatCostManyUnpriced|{"count":2}');

  await React.act(async () => new Promise((resolve) => setTimeout(resolve, 350)));
  assert.deepEqual(globalThis.__previewCalls, [1, 2]);
  assert.match(latest().seatCostLine, /^workspaces\.invite\.seatCostMany\|\{"count":2,"amount":/);
  assert.match(latest().seatCostLine, /24/);
});

test("only seats beyond the plan's free ones are priced", async (t) => {
  globalThis.__seatPreview = {
    seats_used: 4,
    current_quantity: 5,
    amount_due: 1200,
    currency: "usd",
  };
  const { latest } = await mountDialog(t, {
    open: true,
    onOpenChange: () => {},
    workspaceId: "w1",
    workspaceName: "Acme",
    initialEmail: "a@x.com",
  });
  await React.act(async () => {});
  assert.equal(latest().seatCostLine, null);

  // The second address takes the first seat past the plan: the opening preview prices it.
  await React.act(async () => latest().dispatch({ type: "draft", text: "b@x.com," }));
  assert.match(latest().seatCostLine, /^workspaces\.invite\.seatCost\|/);
  assert.deepEqual(globalThis.__previewCalls, [1]);
});

test("the seat cost line hides while invitations are sending", async (t) => {
  globalThis.__seatPreview = {
    seats_used: 5,
    current_quantity: 5,
    amount_due: 1200,
    currency: "usd",
  };
  let release;
  globalThis.__sendGate = new Promise((resolve) => {
    release = resolve;
  });
  const { latest } = await mountDialog(t, {
    open: true,
    onOpenChange: () => {},
    workspaceId: "w1",
    workspaceName: "Acme",
    initialEmail: "a@x.com",
  });
  await React.act(async () => {});
  await React.act(async () => latest().dispatch({ type: "draft", text: "b@x.com," }));

  let sending;
  await React.act(async () => {
    sending = latest().onSend();
  });
  // Every chip is sending, so none counts as sendable, which once let the one-seat line return.
  assert.equal(latest().state.phase, "sending");
  assert.equal(latest().seatCostLine, null);

  await React.act(async () => {
    release();
    await sending;
  });
  assert.equal(latest().state.phase, "done");
});

test("a send reports everyone it invited at once", async (t) => {
  const invited = [];
  const { latest } = await mountDialog(t, {
    open: true,
    onOpenChange: () => {},
    workspaceId: "w1",
    workspaceName: "Acme",
    onInvited: (emails) => invited.push(emails),
  });
  await React.act(async () => latest().dispatch({ type: "draft", text: "a@x.com, b@x.com," }));
  await React.act(async () => latest().onSend());

  assert.deepEqual(invited, [["a@x.com", "b@x.com"]]);
});

test("closing the page mid-send stops the rest of the run", async (t) => {
  let release;
  globalThis.__sendGate = new Promise((resolve) => {
    release = resolve;
  });
  const invited = [];
  const { latest, unmount } = await mountDialog(t, {
    open: true,
    onOpenChange: () => {},
    workspaceId: "w1",
    workspaceName: "Acme",
    initialEmail: "a@x.com",
    onInvited: (emails) => invited.push(emails),
  });
  let sending;
  await React.act(async () => {
    sending = latest().onSend();
  });
  await unmount();

  assert.equal(globalThis.__sendCalls[0].signal.aborted, true);
  release();
  await sending;
  assert.deepEqual(invited, []);
});

const WORKSPACE = { id: "w1", name: "Acme", role: "admin", seats: 20, seat_limit: 500 };

async function mountWithWorkspace(t, workspace, props = {}) {
  globalThis.__workspaces = [workspace];
  return mountDialog(t, {
    open: true,
    onOpenChange: () => {},
    workspaceId: "w1",
    workspaceName: "Acme",
    ...props,
  });
}

test("seats left come from the workspace list", async (t) => {
  const { latest } = await mountWithWorkspace(t, {
    ...WORKSPACE,
    has_subscription: true,
    seats: 20,
    seats_used: 10,
    seat_limit: 500,
  });

  assert.deepEqual(latest().state.seats, { purchasedLeft: 10, ceilingLeft: 490 });
});

test("a free workspace gets no seat warning", async (t) => {
  // A free workspace's seats is a placeholder 1, so it says nothing about room left.
  const { latest } = await mountWithWorkspace(t, {
    ...WORKSPACE,
    has_subscription: false,
    seats: 1,
    seats_used: 3,
  });

  assert.deepEqual(latest().state.seats, { purchasedLeft: null, ceilingLeft: 497 });
});

test("an older API without seat_limit has no ceiling check", async (t) => {
  const { seat_limit: _omitted, ...older } = WORKSPACE;
  const { latest } = await mountWithWorkspace(t, {
    ...older,
    has_subscription: true,
    seats_used: 18,
  });

  assert.deepEqual(latest().state.seats, { purchasedLeft: 2, ceilingLeft: null });
});

test("the view learns who manages billing and how to upgrade", async (t) => {
  const onUpgrade = () => {};
  const { latest } = await mountWithWorkspace(
    t,
    { ...WORKSPACE, role: "admin", billing_manager: "Olivia" },
    { onUpgrade }
  );

  assert.equal(latest().canManageBilling, false);
  assert.equal(latest().billingManager, "Olivia");
  assert.equal(latest().onUpgrade, onUpgrade);
});

test("an owner can upgrade from the invite dialog", async (t) => {
  const { latest } = await mountWithWorkspace(t, { ...WORKSPACE, role: "owner" });

  assert.equal(latest().canManageBilling, true);
  assert.equal(latest().billingManager, null);
});

test("a ceiling refusal refreshes the workspace list so the seats catch up", async (t) => {
  globalThis.__sendOutcome = { ok: false, kind: "seatLimit", available: 0 };
  const { latest } = await mountWithWorkspace(
    t,
    { ...WORKSPACE, seats_used: 499 },
    {
      initialEmail: "a@x.com",
    }
  );

  await React.act(async () => latest().onSend());

  assert.deepEqual(globalThis.__refreshCalls, [{ fresh: true }]);
  assert.equal(latest().state.seats.ceilingLeft, 0);
});

test("a run without a seat refusal leaves the workspace list alone", async (t) => {
  const { latest } = await mountWithWorkspace(t, WORKSPACE, { initialEmail: "a@x.com" });

  await React.act(async () => latest().onSend());

  assert.equal(globalThis.__refreshCalls, undefined);
});
