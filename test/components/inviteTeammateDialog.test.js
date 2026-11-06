const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHostDom,
} = require("../lib/rendererTestHarness");

async function mountDialog(t, props, { realView = false } = {}) {
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
      "__members",
      "__memberListCalls",
      "__settingsRequests",
    ]) {
      delete globalThis[key];
    }
  });
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        searchInviteContacts: async () => ({ success: true, contacts: [] }),
        openSettingsSection: async (section) => {
          (globalThis.__settingsRequests ??= []).push(section);
          return { success: true };
        },
      },
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
        const box = ({ children }) => React.createElement("div", null, children);
        export const Dialog = box;
        export const DialogContent = box;
        export const DialogTitle = box;
        export const DialogDescription = box;
      `,
      "/ui/dropdown-menu": `
        import React from "react";
        const box = ({ children }) => React.createElement("div", null, children);
        export const DropdownMenu = box;
        export const DropdownMenuTrigger = box;
        export const DropdownMenuContent = box;
        export const DropdownMenuRadioGroup = box;
        export const DropdownMenuRadioItem = box;
      `,
      // Records every render's props, so the test can read the state and press Send.
      ...(realView
        ? {}
        : {
            "/InvitePeopleView": `
              export function InvitePeopleView(props) {
                (globalThis.__viewProps ??= []).push(props);
                return null;
              }
            `,
          }),
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
          workspaces: globalThis.__workspaces ?? [],
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
          listMembers: async () => {
            globalThis.__memberListCalls = (globalThis.__memberListCalls ?? 0) + 1;
            return globalThis.__members ?? [];
          },
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
    container,
    latest: () => globalThis.__viewProps.at(-1),
    rerender: async (overrides = {}) => {
      await React.act(async () =>
        root.render(React.createElement(InviteTeammateDialog, { ...props, ...overrides }))
      );
    },
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
  assert.deepEqual(globalThis.__refreshCalls, OPENING_REFRESH);
});

const WORKSPACE = { id: "w1", name: "Acme", role: "admin", seats: 20, seat_limit: 500 };

const OPENING_REFRESH = [{ fresh: true }];

async function mountWithWorkspace(t, workspace, props = {}, options) {
  globalThis.__workspaces = [workspace];
  return mountDialog(
    t,
    {
      open: true,
      onOpenChange: () => {},
      workspaceId: "w1",
      workspaceName: "Acme",
      ...props,
    },
    options
  );
}

test("seats left come from the workspace list", async (t) => {
  const { latest } = await mountWithWorkspace(
    t,
    {
      ...WORKSPACE,
      has_subscription: true,
      seats: 20,
      seats_used: 10,
      seat_limit: 500,
    },
    { knownEmails: { members: [], invited: [] } }
  );

  assert.deepEqual(latest().state.seats, { purchasedLeft: 10, ceilingLeft: 490 });
});

test("the seat line and the seat warning count the same seats", async (t) => {
  // An admin: the owner-only preview refuses, and seats_used counts pending invitations too.
  const { latest } = await mountWithWorkspace(
    t,
    {
      ...WORKSPACE,
      has_subscription: true,
      seats_used: 10,
    },
    { knownEmails: { members: [], invited: [] } }
  );
  await React.act(async () => {});

  assert.equal(latest().seatLine, 'workspaces.invite.seatUsage|{"used":10,"seats":20}');
  assert.deepEqual(latest().state.seats, { purchasedLeft: 10, ceilingLeft: 490 });
  assert.equal(globalThis.__memberListCalls, undefined);
});

test("the seat line prefers the workspace list over the preview", async (t) => {
  globalThis.__seatPreview = {
    seats_used: 9,
    current_quantity: 20,
    amount_due: 1200,
    currency: "usd",
  };
  const { latest } = await mountWithWorkspace(t, {
    ...WORKSPACE,
    has_subscription: true,
    seats_used: 10,
  });
  await React.act(async () => {});

  assert.equal(latest().seatLine, 'workspaces.invite.seatUsage|{"used":10,"seats":20}');
});

test("a free workspace hides the seat line and reads no members for it", async (t) => {
  // Its seats is a placeholder 1, so "Using 12 of 1 seats" would read wrong.
  const { latest } = await mountWithWorkspace(t, {
    ...WORKSPACE,
    has_subscription: false,
    seats: 1,
    seats_used: 12,
  });
  await React.act(async () => {});

  assert.equal(latest().seatLine, null);
  assert.equal(globalThis.__memberListCalls, undefined);
});

test("a free workspace on an older API without seats_used reads no members either", async (t) => {
  const { latest } = await mountWithWorkspace(t, {
    ...WORKSPACE,
    has_subscription: false,
    seats: 1,
  });
  await React.act(async () => {});

  assert.equal(latest().seatLine, null);
  assert.equal(globalThis.__memberListCalls, undefined);
});

test("a subscribed workspace shows the seat line", async (t) => {
  const { latest } = await mountWithWorkspace(t, {
    ...WORKSPACE,
    has_subscription: true,
    seats_used: 12,
  });
  await React.act(async () => {});

  assert.equal(latest().seatLine, 'workspaces.invite.seatUsage|{"used":12,"seats":20}');
  assert.equal(globalThis.__memberListCalls, undefined);
});

test("a subscribed workspace with no count to show hides the line and reads no members", async (t) => {
  // An older API without seats_used, and an admin, whom the owner-only preview refuses.
  const { latest } = await mountWithWorkspace(t, { ...WORKSPACE, has_subscription: true });
  await React.act(async () => {});

  assert.equal(latest().seatLine, null);
  assert.equal(globalThis.__memberListCalls, undefined);
});

test("a free workspace gets no seat warning", async (t) => {
  // A free workspace's seats is a placeholder 1, so it says nothing about room left.
  const { latest } = await mountWithWorkspace(
    t,
    {
      ...WORKSPACE,
      has_subscription: false,
      seats: 1,
      seats_used: 3,
    },
    { knownEmails: { members: [], invited: [] } }
  );

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

test("the view learns who manages billing", async (t) => {
  const { latest } = await mountWithWorkspace(t, {
    ...WORKSPACE,
    role: "admin",
    billing_manager: "Olivia",
  });

  assert.equal(latest().canManageBilling, false);
  assert.equal(latest().billingManager, "Olivia");
});

test("an owner can upgrade from the invite dialog", async (t) => {
  const { latest } = await mountWithWorkspace(t, { ...WORKSPACE, role: "owner" });

  assert.equal(latest().canManageBilling, true);
  assert.equal(latest().billingManager, null);
});

// Seats all taken, so one address brings up the warning. These run the real view, so they read and
// press what a person does, and pass nothing about billing: the caller is any entry point.
const NO_SEATS_LEFT = {
  ...WORKSPACE,
  has_subscription: true,
  seats_used: 20,
  billing_manager: "Olivia",
};
const UPGRADE = "workspaces.invite.upgrade";

function findNode(node, predicate) {
  if (node.nodeType === 1 && predicate(node)) return node;
  for (const child of node.childNodes ?? []) {
    const found = findNode(child, predicate);
    if (found) return found;
  }
  return null;
}

const findUpgrade = (container) =>
  findNode(container, (node) => node.localName === "button" && node.textContent === UPGRADE);

const propsOf = (node) => node[Object.keys(node).find((name) => name.startsWith("__reactProps$"))];

const pressButton = (button) => React.act(async () => propsOf(button).onClick());

test("without a roster, an existing address cannot block a valid batch near the ceiling", async (t) => {
  const { container } = await mountWithWorkspace(
    t,
    { ...WORKSPACE, seats_used: 499, seat_limit: 500 },
    {},
    { realView: true }
  );
  const input = findNode(container, (node) => node.getAttribute("role") === "combobox");
  await React.act(async () => {
    propsOf(input).onChange({ target: { value: "existing@example.com, new@example.com," } });
  });
  const send = findNode(
    container,
    (node) =>
      node.localName === "button" && node.textContent.startsWith("workspaces.invite.submit|")
  );

  assert.ok(send, container.textContent);
  assert.equal(send.hasAttribute("disabled"), false);
  await pressButton(send);
  assert.deepEqual(globalThis.__sendCalls[0].emails, ["existing@example.com", "new@example.com"]);
});

test("without a roster, a seat refusal still allows a valid mixed retry after trimming", async (t) => {
  globalThis.__sendOutcome = { ok: false, kind: "seatLimit", available: 1 };
  const { container, rerender } = await mountWithWorkspace(
    t,
    { ...WORKSPACE, seats_used: 499, seat_limit: 500 },
    {},
    { realView: true }
  );
  const input = findNode(container, (node) => node.getAttribute("role") === "combobox");
  await React.act(async () =>
    propsOf(input).onChange({
      target: { value: "existing@example.com, new@example.com, extra@example.com," },
    })
  );
  const send = () =>
    findNode(
      container,
      (node) => node.localName === "button" && /invite\.submit/.test(node.textContent)
    );
  await pressButton(send());
  assert.deepEqual(globalThis.__refreshCalls, [...OPENING_REFRESH, { fresh: true }]);
  await rerender();
  assert.match(
    findNode(container, (node) => node.getAttribute("role") === "alert")?.textContent ?? "",
    /workspaces\.invite\.errors\.seatLimit/
  );
  const removeExtra = findNode(
    container,
    (node) =>
      node.localName === "button" && node.getAttribute("aria-label")?.includes("extra@example.com")
  );
  await pressButton(removeExtra);

  assert.equal(send().hasAttribute("disabled"), false);
  globalThis.__sendOutcome = { ok: true, emailSent: true };
  await pressButton(send());
  assert.deepEqual(globalThis.__sendCalls[1].emails, ["existing@example.com", "new@example.com"]);
});

test("a complete roster keeps the server ceiling through refresh and a trimmed retry", async (t) => {
  globalThis.__sendOutcome = { ok: false, kind: "seatLimit", available: 1 };
  const { container, rerender } = await mountWithWorkspace(
    t,
    { ...WORKSPACE, seats_used: 498, seat_limit: 500 },
    { knownEmails: { members: ["existing@example.com"], invited: [] } },
    { realView: true }
  );
  const input = findNode(container, (node) => node.getAttribute("role") === "combobox");
  await React.act(async () =>
    propsOf(input).onChange({
      target: { value: "existing@example.com, new@example.com, extra@example.com," },
    })
  );
  const send = () =>
    findNode(
      container,
      (node) => node.localName === "button" && /invite\.submit/.test(node.textContent)
    );
  await pressButton(send());
  assert.deepEqual(globalThis.__sendCalls[0].emails, ["new@example.com", "extra@example.com"]);
  assert.equal(send().hasAttribute("disabled"), true);

  globalThis.__workspaces = [{ ...WORKSPACE, seats_used: 499, seat_limit: 500 }];
  await rerender();
  assert.equal(send().hasAttribute("disabled"), true);
  const removeExtra = findNode(
    container,
    (node) =>
      node.localName === "button" && node.getAttribute("aria-label")?.includes("extra@example.com")
  );
  await pressButton(removeExtra);

  assert.equal(send().hasAttribute("disabled"), false);
  globalThis.__sendOutcome = { ok: true, emailSent: true };
  await pressButton(send());
  assert.deepEqual(globalThis.__sendCalls[1].emails, ["new@example.com"]);
});

test("a roster lost during sending cannot leave a blocking ceiling after refusal", async (t) => {
  let release;
  globalThis.__sendGate = new Promise((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  globalThis.__sendOutcome = { ok: false, kind: "seatLimit", available: 0 };
  const { container, rerender } = await mountWithWorkspace(
    t,
    { ...WORKSPACE, seats_used: 499, seat_limit: 500 },
    { initialEmail: "new@example.com", knownEmails: { members: [], invited: [] } },
    { realView: true }
  );
  const send = () =>
    findNode(
      container,
      (node) => node.localName === "button" && /invite\.submit/.test(node.textContent)
    );
  await pressButton(send());
  await rerender({ knownEmails: undefined });
  await React.act(async () => release());

  assert.deepEqual(globalThis.__refreshCalls, [...OPENING_REFRESH, { fresh: true }]);
  assert.match(
    findNode(container, (node) => node.getAttribute("role") === "alert")?.textContent ?? "",
    /workspaces\.invite\.errors\.seatLimit/
  );
  assert.equal(send().hasAttribute("disabled"), false);
  globalThis.__sendOutcome = { ok: true, emailSent: true };
  await pressButton(send());
  assert.equal(globalThis.__sendCalls.length, 2);
});

test("Upgrade shows from every entry point", async (t) => {
  const { container } = await mountWithWorkspace(
    t,
    { ...NO_SEATS_LEFT, role: "owner" },
    { initialEmail: "a@x.com" },
    { realView: true }
  );
  await React.act(async () => {});

  assert.ok(findUpgrade(container), container.textContent);
});

test("Upgrade closes the dialog and asks for Plan & Billing", async (t) => {
  const steps = [];
  const { container } = await mountWithWorkspace(
    t,
    { ...NO_SEATS_LEFT, role: "owner" },
    {
      initialEmail: "a@x.com",
      onOpenChange: (open) => steps.push(`open:${open}`),
    },
    { realView: true }
  );
  await React.act(async () => {});

  await pressButton(findUpgrade(container));

  assert.deepEqual(steps, ["open:false"]);
  assert.deepEqual(globalThis.__settingsRequests, ["plansBilling"]);
});

test("admins never see it", async (t) => {
  const { container } = await mountWithWorkspace(
    t,
    { ...NO_SEATS_LEFT, role: "admin" },
    { initialEmail: "a@x.com" },
    { realView: true }
  );
  await React.act(async () => {});

  assert.ok(!findUpgrade(container), "no Upgrade for admins");
  assert.match(container.textContent, /workspaces\.invite\.seatsNoneAskOwner/);
  assert.equal(globalThis.__settingsRequests, undefined);
});

test("Upgrade can't interrupt a send with seats already over", async (t) => {
  let release;
  globalThis.__sendGate = new Promise((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  const opens = [];
  const invited = [];
  const { container } = await mountWithWorkspace(
    t,
    { ...NO_SEATS_LEFT, role: "owner", seats_used: 22 },
    {
      initialEmail: "a@x.com",
      onOpenChange: (open) => opens.push(open),
      onInvited: (emails) => invited.push(emails),
    },
    { realView: true }
  );
  await React.act(async () => {});
  assert.ok(findUpgrade(container), "offered before the send");

  const send = findNode(
    container,
    (node) => node.localName === "button" && /invite\.submit/.test(node.textContent)
  );
  let sending;
  await React.act(async () => {
    sending = propsOf(send).onClick();
  });

  assert.equal(globalThis.__sendCalls.length, 1);
  assert.ok(!findUpgrade(container), "no Upgrade while sending");
  assert.deepEqual(opens, []);

  release();
  await React.act(async () => {
    await sending;
  });
  assert.deepEqual(invited, [["a@x.com"]]);
});

test("Upgrade pressed as a send starts leaves the run alone", async (t) => {
  let release;
  globalThis.__sendGate = new Promise((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  const opens = [];
  const invited = [];
  const { latest } = await mountWithWorkspace(
    t,
    { ...NO_SEATS_LEFT, role: "owner" },
    {
      initialEmail: "a@x.com",
      onOpenChange: (open) => opens.push(open),
      onInvited: (emails) => invited.push(emails),
    }
  );
  // A press the render hadn't caught up with: the handler is the view's, from before the send.
  let sending;
  await React.act(async () => {
    sending = latest().onSend();
  });
  assert.equal(latest().state.phase, "sending");

  await React.act(async () => latest().onUpgrade());

  assert.deepEqual(opens, []);
  assert.equal(globalThis.__settingsRequests, undefined);
  assert.equal(globalThis.__sendCalls[0].signal.aborted, false);

  release();
  await React.act(async () => {
    await sending;
  });
  assert.deepEqual(invited, [["a@x.com"]]);
});

test("opening reads the workspace list, since canceled invitations free seats", async (t) => {
  await mountWithWorkspace(t, WORKSPACE, {});

  assert.deepEqual(globalThis.__refreshCalls, OPENING_REFRESH);
});

test("a team or teamspace invite tells the view skipped people aren't added", async (t) => {
  const { latest } = await mountWithWorkspace(t, WORKSPACE, { spaceIds: ["s1"] });

  assert.equal(latest().addsToContainer, true);
});

test("a workspace invite doesn't", async (t) => {
  const { latest } = await mountWithWorkspace(t, WORKSPACE, { teamIds: [] });

  assert.equal(latest().addsToContainer, false);
});

test("a ceiling refusal refreshes the workspace list so the seats catch up", async (t) => {
  globalThis.__sendOutcome = { ok: false, kind: "seatLimit", available: 0 };
  const { latest } = await mountWithWorkspace(
    t,
    { ...WORKSPACE, seats_used: 499 },
    {
      initialEmail: "a@x.com",
      knownEmails: { members: [], invited: [] },
    }
  );

  await React.act(async () => latest().onSend());

  assert.deepEqual(globalThis.__refreshCalls, [...OPENING_REFRESH, { fresh: true }]);
  assert.equal(latest().state.seats.ceilingLeft, 0);
});

test("a run that invited someone refreshes the workspace list so the seats count them", async (t) => {
  const { latest } = await mountWithWorkspace(t, WORKSPACE, { initialEmail: "a@x.com" });

  await React.act(async () => latest().onSend());

  assert.deepEqual(globalThis.__refreshCalls, [...OPENING_REFRESH, { fresh: true }]);
});

test("a run that invited nobody and met no seat refusal leaves the workspace list alone", async (t) => {
  globalThis.__sendOutcome = { ok: false, kind: "requestFailed" };
  const { latest } = await mountWithWorkspace(t, WORKSPACE, { initialEmail: "a@x.com" });

  await React.act(async () => latest().onSend());

  assert.deepEqual(globalThis.__refreshCalls, OPENING_REFRESH);
});

test("an already-member refusal from the switcher invites nobody and says so", async (t) => {
  globalThis.__sendOutcome = { ok: false, kind: "alreadyMember" };
  const invited = [];
  // The workspace switcher passes no knownEmails, so only the server can say who is a member.
  const { latest } = await mountWithWorkspace(t, WORKSPACE, {
    initialEmail: "m@x.com",
    onInvited: (emails) => invited.push(emails),
  });

  await React.act(async () => latest().onSend());

  assert.equal(latest().state.phase, "editing");
  assert.deepEqual(latest().state.sent, []);
  assert.deepEqual(latest().state.recipients, [
    { email: "m@x.com", state: { status: "blocked", reason: "alreadyMember" } },
  ]);
  assert.deepEqual(invited, []);
  assert.deepEqual(globalThis.__refreshCalls, OPENING_REFRESH);
});

test("a run answered already invited refreshes the workspace list so the seats count them", async (t) => {
  globalThis.__sendOutcome = { ok: false, kind: "alreadyInvited" };
  const { latest } = await mountWithWorkspace(t, WORKSPACE, { initialEmail: "a@x.com" });

  await React.act(async () => latest().onSend());

  assert.equal(latest().state.phase, "editing");
  assert.deepEqual(globalThis.__refreshCalls, [...OPENING_REFRESH, { fresh: true }]);
});

test("an already-invited answer asks the caller to reload", async (t) => {
  globalThis.__sendOutcome = { ok: false, kind: "alreadyInvited" };
  const invited = [];
  let changes = 0;
  const { latest } = await mountWithWorkspace(t, WORKSPACE, {
    initialEmail: "a@x.com",
    onInvited: (emails) => invited.push(emails),
    onInvitationsChanged: () => {
      changes += 1;
    },
  });

  await React.act(async () => latest().onSend());

  assert.equal(changes, 1);
  // Nobody was invited, so a caller that says "Invitation sent to" has nothing to say.
  assert.deepEqual(invited, []);
});

test("a run that invited someone asks once", async (t) => {
  const invited = [];
  let changes = 0;
  const { latest } = await mountWithWorkspace(t, WORKSPACE, {
    onInvited: (emails) => invited.push(emails),
    onInvitationsChanged: () => {
      changes += 1;
    },
  });
  await React.act(async () => latest().dispatch({ type: "draft", text: "a@x.com, b@x.com," }));

  await React.act(async () => latest().onSend());

  assert.equal(changes, 1);
  assert.deepEqual(invited, [["a@x.com", "b@x.com"]]);
});

test("an aborted run doesn't", async (t) => {
  let release;
  globalThis.__sendGate = new Promise((resolve) => {
    release = resolve;
  });
  let changes = 0;
  const { latest, unmount } = await mountWithWorkspace(t, WORKSPACE, {
    initialEmail: "a@x.com",
    onInvitationsChanged: () => {
      changes += 1;
    },
  });
  let sending;
  await React.act(async () => {
    sending = latest().onSend();
  });
  await unmount();

  release();
  await sending;
  assert.equal(changes, 0);
});

test("a run that changed no invitation doesn't ask", async (t) => {
  for (const kind of ["alreadyMember", "requestFailed"]) {
    globalThis.__sendOutcome = { ok: false, kind };
    let changes = 0;
    const { latest, unmount } = await mountWithWorkspace(t, WORKSPACE, {
      initialEmail: "a@x.com",
      onInvitationsChanged: () => {
        changes += 1;
      },
    });

    await React.act(async () => latest().onSend());
    await unmount();

    assert.equal(changes, 0, kind);
  }
});

test("initialEmails open as chips and reopening resets to them", async (t) => {
  const { latest, rerender } = await mountDialog(t, {
    open: true,
    onOpenChange: () => {},
    workspaceId: "w1",
    workspaceName: "Acme",
    initialEmails: ["jin@x.com", "ravi@x.com"],
  });
  const chips = () => latest().state.recipients.map((recipient) => recipient.email);
  assert.deepEqual(chips(), ["jin@x.com", "ravi@x.com"]);

  await React.act(async () => latest().dispatch({ type: "remove", email: "jin@x.com" }));
  assert.deepEqual(chips(), ["ravi@x.com"]);

  await rerender({ open: false });
  await rerender({ open: true });
  assert.deepEqual(chips(), ["jin@x.com", "ravi@x.com"]);
});

test("heading replaces the title and description", async (t) => {
  const heading = {
    title: "Invite 2 guests to Ronnie's Space",
    description: "They'll get a link.",
  };
  const { latest } = await mountDialog(t, {
    open: true,
    onOpenChange: () => {},
    workspaceId: "w1",
    workspaceName: "Acme",
    heading,
  });
  assert.deepEqual(latest().heading, heading);

  const { container } = await mountWithWorkspace(t, WORKSPACE, { heading }, { realView: true });
  assert.match(container.textContent, /Invite 2 guests to Ronnie's Space/);
  assert.match(container.textContent, /They'll get a link\./);
  assert.doesNotMatch(container.textContent, /workspaces\.invite\.title/);
});
