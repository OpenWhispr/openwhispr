const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHostDom,
} = require("../lib/rendererTestHarness");

const WORKSPACE = { id: "w1", name: "Acme", seats: 5, role: "admin" };
const DAY_MS = 24 * 60 * 60 * 1000;

const mountedRoots = new Map();

const invitation = (id, email, expiresInMs, overrides = {}) => ({
  id,
  email,
  workspace_role: "member",
  team_ids: [],
  invited_by_user_id: "u1",
  expires_at: new Date(Date.now() + expiresInMs).toISOString(),
  created_at: "2026-10-01T00:00:00.000Z",
  accepted_at: null,
  revoked_at: null,
  ...overrides,
});

// Just under whole days, so the ceil in the days-left count lands on the number named.
const inDays = (days) => days * DAY_MS - 60_000;
const ago = (days) => -days * DAY_MS;

async function loadTab(t) {
  t.after(async () => {
    const root = mountedRoots.get(t);
    mountedRoots.delete(t);
    if (root) await React.act(async () => root.unmount());
    for (const key of [
      "__toasts",
      "__resendCalls",
      "__resendImpl",
      "__cancelDispatches",
      "__cancelState",
      "__cancelManyProps",
      "__bulkResendCalls",
      "__bulkResendImpl",
      "__memberRefreshes",
    ]) {
      delete globalThis[key];
    }
  });
  installBrowserGlobals(t);
  globalThis.__toasts = [];
  globalThis.__resendCalls = [];
  globalThis.__resendImpl = async () => ({ email_sent: true });
  globalThis.__cancelDispatches = [];
  globalThis.__bulkResendCalls = [];
  globalThis.__bulkResendImpl = async (ids) => ({ done: ids, noEmail: [], failed: [] });
  globalThis.__memberRefreshes = [];
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-workspace-invitations-tab-",
    noExternal: ["react-i18next"],
    mockModules: {
      "/i18n": "export default { t: (key) => key };",
      "react-i18next": `
        export const useTranslation = () => ({
          t: (key, options) =>
            options && "count" in options && "email" in options
              ? key + "#" + options.count + "#" + options.email
              : options && "count" in options
                ? key + "#" + options.count
                : options && "email" in options
                  ? key + "#" + options.email
                  : options && "name" in options
                    ? key + "#" + options.name
                    : key,
        });
      `,
      "/ui/useToast": `
        export const useToast = () => ({ toast: (toast) => globalThis.__toasts.push(toast) });
      `,
      "/services/InvitationsService": `
        export const InvitationsService = {
          resend: (workspaceId, invitationId) => {
            globalThis.__resendCalls.push([workspaceId, invitationId]);
            return globalThis.__resendImpl();
          },
        };
      `,
      "/services/bulkInvitationActions": `
        export const bulkInvitationActions = {
          resendInvitations: (workspaceId, ids, signal) => {
            globalThis.__bulkResendCalls.push([workspaceId, ids]);
            return globalThis.__bulkResendImpl(ids, signal);
          },
        };
      `,
      "/CancelInvitationsDialog": `
        export function CancelInvitationsDialog(props) {
          globalThis.__cancelManyProps = props;
          return null;
        }
      `,
      "/stores/workspaceStore": `
        export const useWorkspaceStore = {
          getState: () => ({
            refreshMembers: async (workspaceId) => {
              globalThis.__memberRefreshes.push(workspaceId);
            },
            refresh: async (options) => {
              (globalThis.__seatRefreshes ??= []).push(options);
            },
          }),
        };
      `,
      "/CancelInvitationDialog": `
        import React from "react";
        export function CancelInvitationDialog(props) {
          globalThis.__cancelState = props.state;
          globalThis.__cancelProps = props;
          return null;
        }
      `,
      "/ui/dropdown-menu": `
        import React from "react";
        const h = React.createElement;
        const passThrough = ({ children }) => h(React.Fragment, null, children);
        export const DropdownMenu = passThrough;
        export const DropdownMenuContent = passThrough;
        export const DropdownMenuTrigger = ({ children, disabled, ...rest }) =>
          h("button", { "data-row-actions": "", disabled, "aria-label": rest["aria-label"] }, children);
        export const DropdownMenuItem = ({ children, onSelect, className }) =>
          h("div", { role: "menuitem", className, onClick: onSelect }, children);
      `,
    },
  });
  const module = await vite.ssrLoadModule("/components/settings/WorkspaceInvitationsTab.tsx");
  const { CloudApiError } = await vite.ssrLoadModule("/services/cloudApi.ts");
  return { Tab: module.default, CloudApiError };
}

const ready = (invitations, reload = async () => {}) => ({
  status: "ready",
  invitations,
  reload,
});

function tabElement(Tab, invitations, workspace = WORKSPACE) {
  return React.createElement(Tab, { workspace, invitations });
}

function render(Tab, invitations) {
  return renderToStaticMarkup(tabElement(Tab, invitations));
}

function findNode(node, predicate) {
  if (node.nodeType === 1 && predicate(node)) return node;
  for (const child of node.childNodes ?? []) {
    const found = findNode(child, predicate);
    if (found) return found;
  }
  return null;
}

function propsOf(node) {
  const key = Object.keys(node).find((name) => name.startsWith("__reactProps$"));
  return key ? node[key] : {};
}

function textOf(node) {
  if (node.nodeType === 3) return node.nodeValue;
  return [...node.childNodes].map(textOf).join("");
}

async function mount(t, Tab, invitations) {
  const container = installHostDom(t);
  const root = createRoot(container);
  mountedRoots.set(t, root);
  await React.act(async () => {
    root.render(tabElement(Tab, invitations));
  });
  return container;
}

const menuItem = (container, labelKey) =>
  findNode(
    container,
    (node) => node.getAttribute("role") === "menuitem" && textOf(node).includes(labelKey)
  );

test("empty shows No invitations", async (t) => {
  const { Tab } = await loadTab(t);

  const markup = render(Tab, ready([]));

  assert.match(markup, /settingsPage\.workspace\.people\.invitations\.emptyTitle/);
  assert.match(markup, /settingsPage\.workspace\.people\.invitations\.emptyBody/);
  assert.doesNotMatch(markup, /<table/);
});

test("pending shows days left", async (t) => {
  const { Tab } = await loadTab(t);

  const markup = render(Tab, ready([invitation("i1", "ada@example.com", inDays(3))]));

  assert.match(markup, /settingsPage\.workspace\.people\.invitations\.pending#3/);
  assert.doesNotMatch(markup, /invitations\.expired/);
  assert.match(markup, /settingsPage\.workspace\.role\.member/);
  assert.match(markup, /settingsPage\.workspace\.people\.columns\.email/);
  assert.match(markup, /settingsPage\.workspace\.people\.columns\.role/);
  assert.match(markup, /settingsPage\.workspace\.people\.columns\.status/);
  assert.match(markup, /settingsPage\.workspace\.people\.columns\.actions/);
});

test("a narrow table keeps every email whole, with role and status under it", async (t) => {
  const { Tab } = await loadTab(t);

  const markup = render(Tab, ready([invitation("i1", "ada@example.com", inDays(3))]));

  // The settings pane's width isn't the viewport's, so the frame is what the table responds to.
  assert.match(markup, /<div class="[^"]*@container[^"]*"><table/);
  const email = markup.match(/<p class="([^"]*)"><bdi dir="ltr">ada@example\.com<\/bdi><\/p>/);
  assert.ok(email, "the email is one isolated run");
  const classes = email[1].split(" ");
  assert.ok(classes.includes("break-all"));
  // Truncating is for wide tables only: below the breakpoint rows must stay distinguishable.
  assert.ok(!classes.includes("truncate"));
  assert.ok(classes.includes("@xl:truncate"));
  assert.match(
    markup,
    /<p class="[^"]*@xl:hidden[^"]*text-muted-foreground[^"]*">settingsPage\.workspace\.role\.member · <span title="settingsPage\.workspace\.people\.invitations\.pending#3">\s*settingsPage\.workspace\.people\.invitations\.statusPending<\/span><\/p>/
  );
});

test("role and status show in one place at each width", async (t) => {
  const { Tab } = await loadTab(t);

  const markup = render(Tab, ready([invitation("i1", "ada@example.com", inDays(3))]));

  // Two columns, each hidden until the table is wide enough, in the header and in the row.
  assert.equal(markup.match(/<th [^>]*class="[^"]*hidden @xl:table-cell/g)?.length, 2);
  assert.equal(markup.match(/<td class="[^"]*hidden @xl:table-cell/g)?.length, 2);
  assert.match(
    markup,
    /<td class="[^"]*hidden @xl:table-cell[^"]*">settingsPage\.workspace\.role\.member<\/td>/
  );
  assert.match(
    markup,
    /<td class="[^"]*hidden @xl:table-cell[^"]*" title="settingsPage\.workspace\.people\.invitations\.pending#3">settingsPage\.workspace\.people\.invitations\.statusPending<\/td>/
  );
  // The days left ride in the tooltips of the column and of the second line, and the visible
  // word is the bare status in both.
  assert.equal(markup.match(/invitations\.pending#3/g)?.length, 2);
  assert.equal(markup.match(/invitations\.statusPending/g)?.length, 2);
  assert.equal(markup.match(/workspace\.role\.member/g)?.length, 2);
  // Checkbox and Actions stay at every width.
  assert.equal(markup.match(/<th [^>]*class="(?![^"]*hidden)/g)?.length, 3);
});

test("expired keeps its colour in the wide column and reads muted under the email", async (t) => {
  const { Tab } = await loadTab(t);

  const markup = render(Tab, ready([invitation("i1", "ada@example.com", ago(1))]));

  assert.match(
    markup,
    /<td class="[^"]*hidden @xl:table-cell[^"]*text-destructive[^"]*">settingsPage\.workspace\.people\.invitations\.expired<\/td>/
  );
  assert.match(
    markup,
    /<p class="[^"]*@xl:hidden[^"]*text-muted-foreground[^"]*">settingsPage\.workspace\.role\.member · <span class="text-destructive">settingsPage\.workspace\.people\.invitations\.expired<\/span><\/p>/
  );
});

test("the email is isolated in a left-to-right run", async (t) => {
  const { Tab } = await loadTab(t);

  const markup = render(Tab, ready([invitation("i1", "ada@example.com", inDays(3))]));

  assert.match(markup, /<bdi dir="ltr">ada@example\.com<\/bdi>/);
});

test("expired shows Expired and still offers Resend", async (t) => {
  const { Tab } = await loadTab(t);

  const markup = render(Tab, ready([invitation("i1", "ada@example.com", ago(2))]));

  assert.match(markup, /settingsPage\.workspace\.people\.invitations\.expired/);
  assert.doesNotMatch(markup, /invitations\.pending/);
  assert.match(
    markup,
    /text-destructive[^>]*>settingsPage\.workspace\.people\.invitations\.expired/
  );
  assert.match(markup, /settingsPage\.workspace\.people\.invitations\.resend/);
});

test("an unparseable expiry reads as expired", async (t) => {
  const { Tab } = await loadTab(t);

  const markup = render(
    Tab,
    ready([{ ...invitation("i1", "ada@example.com", 0), expires_at: "not a date" }])
  );

  assert.match(markup, /settingsPage\.workspace\.people\.invitations\.expired/);
  assert.doesNotMatch(markup, /invitations\.pending/);
});

test("failed load shows Try again", async (t) => {
  const { Tab } = await loadTab(t);
  let reloads = 0;
  const container = await mount(t, Tab, {
    status: "failed",
    invitations: [],
    reload: async () => {
      reloads += 1;
    },
  });
  const text = textOf(container);

  assert.match(text, /settingsPage\.workspace\.people\.invitations\.failedTitle/);
  assert.match(text, /settingsPage\.workspace\.people\.failed\.body/);
  assert.doesNotMatch(text, /columns\.email/);

  const retry = findNode(
    container,
    (node) => node.localName === "button" && textOf(node).includes("workspaces.exit.tryAgain")
  );
  assert.ok(retry, "Try again button");
  await React.act(async () => propsOf(retry).onClick());
  assert.equal(reloads, 1);
});

test("loading with no rows shows the loading copy", async (t) => {
  const { Tab } = await loadTab(t);

  const markup = render(Tab, { status: "loading", invitations: [], reload: async () => {} });

  assert.match(markup, /settingsPage\.workspace\.people\.invitations\.loading/);
  assert.doesNotMatch(markup, /invitations\.emptyTitle/);
  assert.doesNotMatch(markup, /columns\.email/);
});

test("row menu offers Resend invite and Cancel invite", async (t) => {
  const { Tab } = await loadTab(t);

  const markup = render(Tab, ready([invitation("i1", "ada@example.com", inDays(3))]));

  assert.match(markup, /aria-label="common\.actions"/);
  assert.match(
    markup,
    /role="menuitem"[^>]*>(?:<svg[\s\S]*?<\/svg>)?settingsPage\.workspace\.people\.invitations\.resend</
  );
  assert.match(
    markup,
    /role="menuitem"[^>]*text-destructive[^>]*>(?:<svg[\s\S]*?<\/svg>)?settingsPage\.workspace\.people\.invitations\.cancel</
  );
});

test("pending rows come before expired", async (t) => {
  const { Tab } = await loadTab(t);

  const markup = render(
    Tab,
    ready([
      invitation("i1", "old@example.com", ago(1)),
      invitation("i2", "soon@example.com", inDays(1)),
      invitation("i3", "later@example.com", inDays(5)),
    ])
  );

  const order = ["soon@example.com", "later@example.com", "old@example.com"].map((email) =>
    markup.indexOf(email)
  );
  assert.ok(order.every((index) => index >= 0));
  assert.deepEqual(
    order,
    [...order].sort((a, b) => a - b)
  );
});

test("Cancel invite opens the confirm dialog for that row", async (t) => {
  const { Tab } = await loadTab(t);
  const rows = [invitation("i1", "ada@example.com", inDays(3))];
  const container = await mount(t, Tab, ready(rows));

  await React.act(async () => propsOf(menuItem(container, "invitations.cancel")).onClick());

  assert.deepEqual(globalThis.__cancelState, { kind: "confirm", subject: rows[0] });
});

test("resending reloads the list and toasts", async (t) => {
  const { Tab } = await loadTab(t);
  let reloads = 0;
  const container = await mount(
    t,
    Tab,
    ready([invitation("i1", "ada@example.com", inDays(3))], async () => {
      reloads += 1;
    })
  );

  await React.act(async () => propsOf(menuItem(container, "invitations.resend")).onClick());

  assert.deepEqual(globalThis.__resendCalls, [["w1", "i1"]]);
  assert.equal(reloads, 1);
  assert.deepEqual(globalThis.__toasts, [{ title: "settingsPage.workspace.invites.resent" }]);
});

test("a resend whose email could not be delivered says so", async (t) => {
  const { Tab } = await loadTab(t);
  globalThis.__resendImpl = async () => ({ email_sent: false });
  const container = await mount(t, Tab, ready([invitation("i1", "ada@example.com", inDays(3))]));

  await React.act(async () => propsOf(menuItem(container, "invitations.resend")).onClick());

  assert.deepEqual(globalThis.__toasts, [
    { title: "settingsPage.workspace.invites.resentNoEmail", variant: "destructive" },
  ]);
});

test("a resend for an invitation that is gone reloads and says to invite again", async (t) => {
  const { Tab, CloudApiError } = await loadTab(t);
  globalThis.__resendImpl = async () => {
    throw new CloudApiError("Invitation not found", 404);
  };
  let reloads = 0;
  const container = await mount(
    t,
    Tab,
    ready([invitation("i1", "ada@example.com", inDays(3))], async () => {
      reloads += 1;
      return [invitation("i1", "ada@example.com", inDays(3))];
    })
  );

  await React.act(async () => propsOf(menuItem(container, "invitations.resend")).onClick());

  assert.equal(reloads, 1);
  assert.deepEqual(globalThis.__toasts, [
    {
      title: "settingsPage.workspace.people.invitations.resendFailed#\u2068ada@example.com\u2069",
      variant: "destructive",
    },
  ]);
  assert.deepEqual(globalThis.__memberRefreshes, []);
});

test("a resend for an invitation no longer listed says it's no longer pending", async (t) => {
  const { Tab, CloudApiError } = await loadTab(t);
  globalThis.__resendImpl = async () => {
    throw new CloudApiError("Invitation not found", 404);
  };
  const container = await mount(
    t,
    Tab,
    ready([invitation("i1", "ada@example.com", inDays(3))], async () => [])
  );

  await React.act(async () => propsOf(menuItem(container, "invitations.resend")).onClick());

  assert.deepEqual(globalThis.__toasts, [
    {
      title:
        "settingsPage.workspace.people.invitations.noLongerPending#\u2068ada@example.com\u2069",
      variant: undefined,
    },
  ]);
  // It may have been accepted, which adds a member.
  assert.deepEqual(globalThis.__memberRefreshes, ["w1"]);
});

test("a resend refused for single sign-on says to sign in with it", async (t) => {
  const { Tab, CloudApiError } = await loadTab(t);
  globalThis.__resendImpl = async () => {
    throw new CloudApiError("Sign in with company SSO", 403, "SSO_REQUIRED");
  };
  const container = await mount(t, Tab, ready([invitation("i1", "ada@example.com", inDays(3))]));

  await React.act(async () => propsOf(menuItem(container, "invitations.resend")).onClick());

  assert.deepEqual(globalThis.__toasts, [
    { title: "workspaces.ssoRequired", variant: "destructive" },
  ]);
});

test("a list that couldn't be refreshed says it may be out of date", async (t) => {
  const { Tab } = await loadTab(t);
  for (const rows of [[], [invitation("i1", "ada@example.com", inDays(3))]]) {
    assert.match(
      render(Tab, { ...ready(rows), stale: true }),
      /settingsPage\.workspace\.people\.invitations\.refreshFailed/
    );
    assert.doesNotMatch(render(Tab, ready(rows)), /refreshFailed/);
  }

  let reloads = 0;
  const container = await mount(t, Tab, {
    ...ready([], async () => {
      reloads += 1;
    }),
    stale: true,
  });
  const retry = findNode(
    container,
    (node) => node.localName === "button" && textOf(node).includes("workspaces.exit.tryAgain")
  );
  assert.ok(retry, "Try again button for an empty stale list");
  await React.act(async () => propsOf(retry).onClick());
  assert.equal(reloads, 1);
});

test("a refused resend shows the server's message", async (t) => {
  const { Tab, CloudApiError } = await loadTab(t);
  globalThis.__resendImpl = async () => {
    throw new CloudApiError("Invitation already accepted", 400);
  };
  const container = await mount(t, Tab, ready([invitation("i1", "ada@example.com", inDays(3))]));

  await React.act(async () => propsOf(menuItem(container, "invitations.resend")).onClick());

  assert.deepEqual(globalThis.__toasts, [
    { title: "common.error", description: "Invitation already accepted", variant: "destructive" },
  ]);
});

test("any other resend failure shows the generic error", async (t) => {
  const { Tab } = await loadTab(t);
  globalThis.__resendImpl = async () => {
    throw new Error("offline");
  };
  const container = await mount(t, Tab, ready([invitation("i1", "ada@example.com", inDays(3))]));

  await React.act(async () => propsOf(menuItem(container, "invitations.resend")).onClick());

  assert.deepEqual(globalThis.__toasts, [
    { title: "common.error", description: "common.unknownError", variant: "destructive" },
  ]);
});

test("a resending row shows the spinner and is disabled", async (t) => {
  const { Tab } = await loadTab(t);
  let finish;
  globalThis.__resendImpl = () => new Promise((resolve) => (finish = resolve));
  const container = await mount(
    t,
    Tab,
    ready([
      invitation("i1", "ada@example.com", inDays(3)),
      invitation("i2", "bob@example.com", inDays(4)),
    ])
  );

  await React.act(async () => {
    propsOf(menuItem(container, "invitations.resend")).onClick();
  });

  const triggers = [];
  const collect = (node) => {
    if (node.nodeType === 1 && node.hasAttribute("data-row-actions")) triggers.push(node);
    for (const child of node.childNodes ?? []) collect(child);
  };
  collect(container);
  assert.equal(triggers.length, 2);
  assert.match(textOf(triggers[0]), /settingsPage\.workspace\.invites\.resending/);
  assert.ok(triggers[0].hasAttribute("disabled"));
  assert.doesNotMatch(textOf(triggers[1]), /resending/);
  assert.ok(!triggers[1].hasAttribute("disabled"));

  await React.act(async () => finish({ email_sent: true }));
  assert.doesNotMatch(textOf(container), /resending/);
});

function allNodes(node, predicate, found = []) {
  if (node.nodeType === 1 && predicate(node)) found.push(node);
  for (const child of node.childNodes ?? []) allNodes(child, predicate, found);
  return found;
}

const resendItems = (container) =>
  allNodes(
    container,
    (node) =>
      node.getAttribute("role") === "menuitem" && textOf(node).includes("invitations.resend")
  );
const rowTriggers = (container) =>
  allNodes(container, (node) => node.hasAttribute("data-row-actions"));

test("two resends at once keep their own spinners, and a row resends only once", async (t) => {
  const { Tab } = await loadTab(t);
  const finishers = [];
  globalThis.__resendImpl = () => new Promise((resolve) => finishers.push(resolve));
  const container = await mount(
    t,
    Tab,
    ready([
      invitation("i1", "ada@example.com", inDays(3)),
      invitation("i2", "bob@example.com", inDays(4)),
    ])
  );

  await React.act(async () => {
    propsOf(resendItems(container)[0]).onClick();
    propsOf(resendItems(container)[1]).onClick();
    // A second Resend on a row still sending asks nothing of the server.
    propsOf(resendItems(container)[0]).onClick();
  });
  assert.deepEqual(globalThis.__resendCalls, [
    ["w1", "i1"],
    ["w1", "i2"],
  ]);
  const [first, second] = rowTriggers(container);
  assert.match(textOf(first), /resending/);
  assert.match(textOf(second), /resending/);

  await React.act(async () => finishers[0]({ email_sent: true }));
  const [firstAfter, secondAfter] = rowTriggers(container);
  assert.doesNotMatch(textOf(firstAfter), /resending/);
  assert.match(textOf(secondAfter), /resending/);
  assert.ok(secondAfter.hasAttribute("disabled"));

  await React.act(async () => finishers[1]({ email_sent: true }));
  assert.doesNotMatch(textOf(container), /resending/);
});

test("a resend without permission says the permission is gone", async (t) => {
  const { Tab, CloudApiError } = await loadTab(t);
  globalThis.__resendImpl = async () => {
    throw new CloudApiError("Insufficient role", 403);
  };
  const container = await mount(t, Tab, ready([invitation("i1", "ada@example.com", inDays(3))]));

  await React.act(async () => propsOf(resendItems(container)[0]).onClick());

  assert.deepEqual(globalThis.__toasts, [
    {
      title: "settingsPage.workspace.people.invitations.resendNotAllowed",
      variant: "destructive",
    },
  ]);
});

test("narrow column headers don't wrap", async (t) => {
  const { Tab } = await loadTab(t);
  const markup = render(Tab, ready([invitation("i1", "ada@example.com", inDays(3))]));

  // Actions is blank on screen: its name is for screen readers only.
  for (const column of ["role", "status", "actions"]) {
    const header = markup.match(
      new RegExp(
        `<th[^>]*>(?:<span class="sr-only">)?settingsPage\\.workspace\\.people\\.columns\\.${column}(?:</span>)?</th>`
      )
    );
    assert.ok(header, column);
    assert.match(header[0], /whitespace-nowrap/, column);
  }
});

const ADA = "\u2068ada@example.com\u2069";
const SELECT_ROW = "settingsPage.workspace.people.selection.selectRow#";
const SELECT_ALL = "settingsPage.workspace.people.selection.selectAllInvitations";
const INVITATIONS = "settingsPage.workspace.people.invitations.";

const twoRows = () => [
  invitation("i1", "ada@example.com", inDays(3)),
  invitation("i2", "bob@example.com", inDays(4)),
];
const checkbox = (container, label) =>
  findNode(
    container,
    (node) => node.getAttribute("role") === "checkbox" && node.getAttribute("aria-label") === label
  );
const check = async (container, label) =>
  React.act(async () => propsOf(checkbox(container, label)).onClick());
const ariaChecked = (container, label) => checkbox(container, label).getAttribute("aria-checked");
const barButton = (container, labelKey) =>
  findNode(
    container,
    (node) => node.localName === "button" && textOf(node).includes(`${INVITATIONS}${labelKey}`)
  );
// One selected invitation reads singular, in words the row menu uses too.
const barAction = (container, labelKey) =>
  findNode(
    findNode(container, (node) => node.getAttribute("role") === "region"),
    (node) => node.localName === "button" && textOf(node) === `${INVITATIONS}${labelKey}`
  );
const selectedCount = (container) => {
  const match = textOf(container).match(/selection\.count#(\d+)/);
  return match ? Number(match[1]) : 0;
};

test("selecting invitations shows Cancel invites and Resend invites", async (t) => {
  const { Tab } = await loadTab(t);
  const rows = twoRows();
  const container = await mount(t, Tab, ready(rows));
  assert.doesNotMatch(textOf(container), /cancelSelected/);

  await check(container, SELECT_ALL);

  assert.equal(selectedCount(container), 2);
  assert.ok(barButton(container, "resendSelected"));
  assert.match(
    barButton(container, "cancelSelected").getAttribute("class"),
    /text-destructive/,
    "Cancel invites is destructive"
  );

  await React.act(async () => propsOf(barButton(container, "cancelSelected")).onClick());
  assert.deepEqual(globalThis.__cancelManyProps.state, { kind: "confirm", subject: rows });
});

test("one selected invitation reads singular and uses its own dialog", async (t) => {
  const { Tab } = await loadTab(t);
  const rows = twoRows();
  const container = await mount(t, Tab, ready(rows));

  await check(container, `${SELECT_ROW}\u2068bob@example.com\u2069`);

  assert.equal(selectedCount(container), 1);
  assert.doesNotMatch(textOf(container), /cancelSelected|resendSelected/);
  await React.act(async () => propsOf(barAction(container, "cancel")).onClick());

  assert.deepEqual(globalThis.__cancelProps.state, { kind: "confirm", subject: rows[1] });
  assert.equal(globalThis.__cancelManyProps.state.kind, "closed");
});

test("a canceled or renewed invitation re-reads the seats", async (t) => {
  const { Tab } = await loadTab(t);
  const container = await mount(t, Tab, ready(twoRows()));
  globalThis.__seatRefreshes = [];
  const refreshes = () => globalThis.__seatRefreshes.length;

  await React.act(async () => globalThis.__cancelManyProps.onCanceled(["i1"], false));
  assert.equal(refreshes(), 1);

  await React.act(async () => globalThis.__cancelProps.onCanceled("canceled"));
  assert.equal(refreshes(), 2);

  await React.act(async () => propsOf(menuItem(container, "invitations.resend")).onClick());
  assert.equal(refreshes(), 3);
});

test("the header checkbox selects every invitation and a second press clears them", async (t) => {
  const { Tab } = await loadTab(t);
  const container = await mount(t, Tab, ready(twoRows()));

  await check(container, SELECT_ALL);
  assert.equal(selectedCount(container), 2);
  assert.equal(ariaChecked(container, SELECT_ALL), "true");

  await check(container, SELECT_ALL);
  assert.equal(selectedCount(container), 0);
});

test("resend clears the resent rows from the selection", async (t) => {
  const { Tab } = await loadTab(t);
  let reloads = 0;
  const container = await mount(
    t,
    Tab,
    ready(twoRows(), async () => {
      reloads += 1;
    })
  );
  await check(container, SELECT_ALL);

  await React.act(async () => propsOf(barButton(container, "resendSelected")).onClick());

  assert.deepEqual(globalThis.__bulkResendCalls, [["w1", ["i1", "i2"]]]);
  assert.equal(reloads, 1);
  assert.deepEqual(globalThis.__toasts, [{ title: `${INVITATIONS}resentMany#2` }]);
  assert.equal(selectedCount(container), 0);
});

test("a partial resend with several failures counts them", async (t) => {
  const { Tab } = await loadTab(t);
  globalThis.__bulkResendImpl = async () => ({
    done: ["i1"],
    noEmail: [],
    failed: [
      { id: "i2", error: { kind: "failed" } },
      { id: "i3", error: { kind: "failed" } },
    ],
  });
  const rows = twoRows();
  const container = await mount(
    t,
    Tab,
    ready([...rows, { ...rows[1], id: "i3", email: "cy@example.com" }])
  );
  await check(container, SELECT_ALL);

  await React.act(async () => propsOf(barButton(container, "resendSelected")).onClick());

  assert.deepEqual(globalThis.__toasts, [
    {
      title: `${INVITATIONS}resentPartial#1`,
      description: `${INVITATIONS}resendFailedSome#2`,
    },
  ]);
});

test("a partial resend keeps the failed row selected and names it", async (t) => {
  const { Tab } = await loadTab(t);
  globalThis.__bulkResendImpl = async () => ({
    done: ["i1"],
    noEmail: [],
    failed: [{ id: "i2", error: { kind: "failed" } }],
  });
  const container = await mount(t, Tab, ready(twoRows()));
  await check(container, SELECT_ALL);

  await React.act(async () => propsOf(barButton(container, "resendSelected")).onClick());

  assert.deepEqual(globalThis.__toasts, [
    {
      title: `${INVITATIONS}resentPartial#1`,
      description: `${INVITATIONS}resendFailedOne#\u2068bob@example.com\u2069`,
    },
  ]);
  assert.equal(selectedCount(container), 1);
  assert.equal(ariaChecked(container, `${SELECT_ROW}\u2068bob@example.com\u2069`), "true");
  assert.equal(ariaChecked(container, `${SELECT_ROW}${ADA}`), "false");

  // Resend invites again retries only the failed one.
  globalThis.__bulkResendImpl = async (ids) => ({ done: ids, noEmail: [], failed: [] });
  await React.act(async () => propsOf(barAction(container, "resend")).onClick());
  assert.deepEqual(globalThis.__bulkResendCalls.at(-1), ["w1", ["i2"]]);
  assert.equal(selectedCount(container), 0);
});

test("resending disables the bar and the row menus", async (t) => {
  const { Tab } = await loadTab(t);
  let finish;
  globalThis.__bulkResendImpl = (ids) =>
    new Promise((resolve) => (finish = () => resolve({ done: ids, noEmail: [], failed: [] })));
  const container = await mount(t, Tab, ready(twoRows()));
  await check(container, SELECT_ALL);

  await React.act(async () => {
    propsOf(barButton(container, "resendSelected")).onClick();
  });

  const resending = barButton(container, "resendingSelected");
  assert.ok(resending, "the bar shows the busy label");
  assert.equal(resending.getAttribute("aria-disabled"), "true");
  assert.equal(barButton(container, "cancelSelected").getAttribute("aria-disabled"), "true");
  assert.equal(propsOf(barButton(container, "cancelSelected")).onClick, undefined);
  assert.ok(rowTriggers(container).every((trigger) => trigger.hasAttribute("disabled")));
  assert.doesNotMatch(
    textOf(rowTriggers(container)[0]),
    /settingsPage\.workspace\.invites\.resending/
  );

  await React.act(async () => finish());
  assert.ok(rowTriggers(container).every((trigger) => !trigger.hasAttribute("disabled")));
});

test("resending freezes the checkboxes until it reports", async (t) => {
  const { Tab } = await loadTab(t);
  let finish;
  globalThis.__bulkResendImpl = () =>
    new Promise((resolve) => (finish = () => resolve({ done: [], noEmail: [], failed: [] })));
  const container = await mount(t, Tab, ready(twoRows()));
  await check(container, SELECT_ALL);
  const checkboxes = () =>
    [SELECT_ALL, `${SELECT_ROW}${ADA}`].map((label) => checkbox(container, label));

  await React.act(async () => {
    propsOf(barButton(container, "resendSelected")).onClick();
  });

  assert.ok(checkboxes().every((box) => box.hasAttribute("disabled")));

  await React.act(async () => finish());
  assert.ok(checkboxes().every((box) => !box.hasAttribute("disabled")));
});

test("a bulk resend stays busy when Settings remounts its invitations panel", async (t) => {
  const { Tab } = await loadTab(t);
  let finish;
  globalThis.__bulkResendImpl = (ids) =>
    new Promise((resolve) => (finish = () => resolve({ done: ids, noEmail: [], failed: [] })));
  const original = await mount(t, Tab, ready(twoRows()));
  await check(original, SELECT_ALL);
  await React.act(async () => propsOf(barButton(original, "resendSelected")).onClick());

  await React.act(async () => mountedRoots.get(t).unmount());
  mountedRoots.delete(t);
  const reopened = await mount(t, Tab, ready(twoRows()));

  assert.ok(checkbox(reopened, SELECT_ALL).hasAttribute("disabled"));
  assert.ok(rowTriggers(reopened).every((trigger) => trigger.hasAttribute("disabled")));
  await React.act(async () => propsOf(menuItem(reopened, "invitations.resend")).onClick());
  assert.deepEqual(globalThis.__resendCalls, []);
  assert.equal(globalThis.__bulkResendCalls.length, 1);

  await React.act(async () => finish());
  assert.equal(checkbox(reopened, SELECT_ALL).hasAttribute("disabled"), false);
  assert.ok(rowTriggers(reopened).every((trigger) => !trigger.hasAttribute("disabled")));
  globalThis.__bulkResendImpl = async (ids) => ({ done: ids, noEmail: [], failed: [] });
  await check(reopened, SELECT_ALL);
  await React.act(async () => propsOf(barButton(reopened, "resendSelected")).onClick());
  assert.equal(globalThis.__bulkResendCalls.length, 2);
});

test("a pending row resend blocks bulk resend before rendering and until it settles", async (t) => {
  const { Tab } = await loadTab(t);
  let finish;
  globalThis.__resendImpl = () =>
    new Promise((resolve) => (finish = () => resolve({ email_sent: true })));
  const container = await mount(t, Tab, ready(twoRows()));
  await check(container, SELECT_ALL);
  const resendSelected = propsOf(barButton(container, "resendSelected")).onClick;

  await React.act(async () => {
    propsOf(menuItem(container, "invitations.resend")).onClick();
    resendSelected();
  });

  assert.equal(globalThis.__resendCalls.length, 1);
  assert.equal(globalThis.__bulkResendCalls.length, 0);
  assert.equal(barButton(container, "resendingSelected").getAttribute("aria-disabled"), "true");

  await React.act(async () => finish());
  await React.act(async () => propsOf(barButton(container, "resendSelected")).onClick());
  assert.equal(globalThis.__bulkResendCalls.length, 1);
});

test("leaving the tab mid-resend still resends the rest and reports", async (t) => {
  const { Tab } = await loadTab(t);
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  let finished;
  const done = new Promise((resolve) => (finished = resolve));
  // Asks one invitation at a time and stops at an abort, as the real loop does.
  globalThis.__bulkResendImpl = async (ids, signal) => {
    const sent = [];
    for (const id of ids) {
      if (signal?.aborted) break;
      await gate;
      sent.push(id);
    }
    finished();
    return { done: sent, noEmail: [], failed: [] };
  };
  let reloads = 0;
  const container = await mount(
    t,
    Tab,
    ready(twoRows(), async () => {
      reloads += 1;
    })
  );
  await check(container, SELECT_ALL);
  await React.act(async () => {
    propsOf(barButton(container, "resendSelected")).onClick();
  });

  await React.act(async () => mountedRoots.get(t).unmount());
  mountedRoots.delete(t);
  release();
  await done;
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(reloads, 1);
  assert.deepEqual(globalThis.__toasts, [{ title: `${INVITATIONS}resentMany#2` }]);
});

test("a reload that drops an invitation drops it from the selection", async (t) => {
  const { Tab } = await loadTab(t);
  const rows = twoRows();
  const container = await mount(t, Tab, ready(rows));
  await check(container, SELECT_ALL);
  assert.equal(selectedCount(container), 2);

  await React.act(async () => mountedRoots.get(t).render(tabElement(Tab, ready([rows[1]]))));

  assert.equal(selectedCount(container), 1);
  assert.equal(ariaChecked(container, `${SELECT_ROW}\u2068bob@example.com\u2069`), "true");
});

test("canceled invitations reload the list and leave the selection", async (t) => {
  const { Tab } = await loadTab(t);
  let reloads = 0;
  const container = await mount(
    t,
    Tab,
    ready(twoRows(), async () => {
      reloads += 1;
    })
  );
  await check(container, SELECT_ALL);

  await React.act(async () => globalThis.__cancelManyProps.onCanceled(["i1"], false));

  assert.equal(reloads, 1);
  assert.equal(selectedCount(container), 1);
  assert.equal(ariaChecked(container, `${SELECT_ROW}${ADA}`), "false");

  // A retry reports only its own ids, so each report is additive.
  await React.act(async () => globalThis.__cancelManyProps.onCanceled(["i2"], false));
  assert.equal(reloads, 2);
  assert.equal(selectedCount(container), 0);
});

test("a resend that sent nothing says so, or names the lost permission", async (t) => {
  const { Tab } = await loadTab(t);
  globalThis.__bulkResendImpl = async () => ({
    done: [],
    noEmail: [],
    failed: [
      { id: "i1", error: { kind: "failed" } },
      { id: "i2", error: { kind: "failed" } },
    ],
  });
  const container = await mount(t, Tab, ready(twoRows()));
  await check(container, SELECT_ALL);

  await React.act(async () => propsOf(barButton(container, "resendSelected")).onClick());
  assert.deepEqual(globalThis.__toasts, [
    { title: `${INVITATIONS}resendFailedAll#2`, variant: "destructive" },
  ]);
  assert.equal(selectedCount(container), 2);

  globalThis.__toasts.length = 0;
  globalThis.__bulkResendImpl = async () => ({
    done: [],
    noEmail: [],
    failed: [
      { id: "i1", error: { kind: "notAllowed" } },
      { id: "i2", error: { kind: "notAllowed" } },
    ],
  });
  await React.act(async () => propsOf(barButton(container, "resendSelected")).onClick());
  assert.deepEqual(globalThis.__toasts, [
    { title: `${INVITATIONS}resendNotAllowed`, variant: "destructive" },
  ]);

  globalThis.__toasts.length = 0;
  globalThis.__bulkResendImpl = async () => ({
    done: [],
    noEmail: [],
    failed: [{ id: "i1", error: { kind: "ssoRequired" } }],
  });
  await React.act(async () => propsOf(barButton(container, "resendSelected")).onClick());
  assert.deepEqual(globalThis.__toasts, [
    { title: "workspaces.ssoRequired", variant: "destructive" },
  ]);
});

test("an email that wasn't delivered isn't counted as resent, and its row stays selected", async (t) => {
  const { Tab } = await loadTab(t);
  globalThis.__bulkResendImpl = async (ids) => ({ done: ids, noEmail: ["i1"], failed: [] });
  const container = await mount(t, Tab, ready(twoRows()));
  await check(container, SELECT_ALL);

  await React.act(async () => propsOf(barButton(container, "resendSelected")).onClick());

  assert.deepEqual(globalThis.__toasts, [
    { title: `${INVITATIONS}resentMany#1` },
    { title: `${INVITATIONS}resentNoEmailOne#${ADA}`, variant: "destructive" },
  ]);
  assert.equal(selectedCount(container), 1);
  assert.equal(ariaChecked(container, `${SELECT_ROW}${ADA}`), "true");
});

test("when no email was delivered, nothing claims a resend", async (t) => {
  const { Tab } = await loadTab(t);
  globalThis.__bulkResendImpl = async (ids) => ({ done: ids, noEmail: ids, failed: [] });
  const container = await mount(t, Tab, ready(twoRows()));
  await check(container, SELECT_ALL);

  await React.act(async () => propsOf(barButton(container, "resendSelected")).onClick());

  assert.deepEqual(globalThis.__toasts, [
    { title: `${INVITATIONS}resentNoEmailMany#2`, variant: "destructive" },
  ]);
  assert.equal(selectedCount(container), 2);
});

test("an expired invitation the server won't renew says to cancel it, not to retry", async (t) => {
  const { Tab } = await loadTab(t);
  globalThis.__bulkResendImpl = async () => ({
    done: [],
    noEmail: [],
    failed: [
      { id: "i1", error: { kind: "gone" } },
      { id: "i2", error: { kind: "gone" } },
    ],
  });
  // Both stay listed, which is what tells them apart from an accepted invitation.
  const container = await mount(
    t,
    Tab,
    ready(twoRows(), async () => twoRows())
  );
  await check(container, SELECT_ALL);

  await React.act(async () => propsOf(barButton(container, "resendSelected")).onClick());

  assert.deepEqual(globalThis.__toasts, [
    { title: `${INVITATIONS}resendUnrenewable#2`, variant: "destructive" },
  ]);
  // Still selected, so Cancel invites is one press away.
  assert.equal(selectedCount(container), 2);
});

test("a partial resend says why the rest failed when the server did", async (t) => {
  const { Tab } = await loadTab(t);
  const container = await mount(
    t,
    Tab,
    ready(twoRows(), async () => twoRows())
  );
  await check(container, SELECT_ALL);

  for (const [error, description] of [
    [{ kind: "gone" }, `${INVITATIONS}resendUnrenewable#1`],
    [{ kind: "refused", message: "Seat limit reached" }, "Seat limit reached"],
    [{ kind: "notAllowed" }, `${INVITATIONS}resendNotAllowed`],
  ]) {
    globalThis.__toasts.length = 0;
    globalThis.__bulkResendImpl = async () => ({
      done: [],
      noEmail: [],
      failed: [{ id: "i2", error }],
    });
    await React.act(async () => propsOf(barButton(container, "resendSelected")).onClick());
    assert.equal(globalThis.__toasts[0].title, description);

    globalThis.__toasts.length = 0;
    globalThis.__bulkResendImpl = async () => ({
      done: ["i1"],
      noEmail: [],
      failed: [{ id: "i2", error }],
    });
    await React.act(async () => propsOf(barButton(container, "resendSelected")).onClick());
    assert.deepEqual(globalThis.__toasts, [
      { title: `${INVITATIONS}resentPartial#1`, description },
    ]);
    await check(container, SELECT_ALL);
  }
});

test("a bulk cancel that found invitations already gone refreshes the members", async (t) => {
  const { Tab } = await loadTab(t);
  const container = await mount(t, Tab, ready(twoRows()));
  await check(container, SELECT_ALL);

  await React.act(async () => globalThis.__cancelManyProps.onCanceled(["i1"], false));
  assert.deepEqual(globalThis.__memberRefreshes, []);

  await React.act(async () => globalThis.__cancelManyProps.onCanceled(["i2"], true));
  assert.deepEqual(globalThis.__memberRefreshes, [WORKSPACE.id]);
});

test("a failed resend of an invitation that left the list refreshes the members", async (t) => {
  const { Tab } = await loadTab(t);
  globalThis.__bulkResendImpl = async () => ({
    done: ["i1"],
    noEmail: [],
    failed: [{ id: "i2", error: { kind: "gone" } }],
  });
  const rows = twoRows();
  const container = await mount(
    t,
    Tab,
    ready(rows, async () => [rows[0]])
  );
  await check(container, SELECT_ALL);

  await React.act(async () => propsOf(barButton(container, "resendSelected")).onClick());

  assert.deepEqual(globalThis.__memberRefreshes, ["w1"]);
});

const threeRows = () => [...twoRows(), invitation("i3", "cleo@example.com", inDays(5))];
const BOB = "\u2068bob@example.com\u2069";
const CLEO = "\u2068cleo@example.com\u2069";
const RATE_LIMITED = "workspaces.invite.errors.rateLimited";

async function resendAll(t, Tab, rows, listedAfter, answer) {
  globalThis.__bulkResendImpl = async () => answer;
  const container = await mount(
    t,
    Tab,
    ready(rows, async () => listedAfter)
  );
  await check(container, SELECT_ALL);
  await React.act(async () => propsOf(barButton(container, "resendSelected")).onClick());
  return container;
}

test("a row that left the list isn't reported as failed", async (t) => {
  const { Tab } = await loadTab(t);
  const rows = twoRows();

  await resendAll(t, Tab, rows, [rows[0]], {
    done: ["i1"],
    noEmail: [],
    failed: [{ id: "i2", error: { kind: "failed" } }],
  });

  assert.deepEqual(globalThis.__toasts, [
    {
      title: `${INVITATIONS}resentMany#1`,
      description: `${INVITATIONS}noLongerPending#${BOB}`,
    },
  ]);
  assert.deepEqual(globalThis.__memberRefreshes, ["w1"]);
});

test("several rows that left the list are counted", async (t) => {
  const { Tab } = await loadTab(t);
  const rows = threeRows();

  await resendAll(t, Tab, rows, [rows[0]], {
    done: ["i1"],
    noEmail: [],
    failed: [
      { id: "i2", error: { kind: "gone" } },
      { id: "i3", error: { kind: "gone" } },
    ],
  });

  assert.deepEqual(globalThis.__toasts, [
    {
      title: `${INVITATIONS}resentMany#1`,
      description: `${INVITATIONS}noLongerPendingMany#2`,
    },
  ]);
});

test("only rows that left the list say so, on their own", async (t) => {
  const { Tab } = await loadTab(t);
  const rows = twoRows();

  await resendAll(t, Tab, rows, [], {
    done: [],
    noEmail: [],
    failed: [
      { id: "i1", error: { kind: "gone" } },
      { id: "i2", error: { kind: "gone" } },
    ],
  });

  assert.deepEqual(globalThis.__toasts, [{ title: `${INVITATIONS}noLongerPendingMany#2` }]);
  assert.deepEqual(globalThis.__memberRefreshes, ["w1"]);
});

test("a listed failure keeps its toast and selection beside a row that left", async (t) => {
  const { Tab } = await loadTab(t);
  const rows = threeRows();

  const container = await resendAll(t, Tab, rows, [rows[0], rows[1]], {
    done: ["i1"],
    noEmail: [],
    failed: [
      { id: "i2", error: { kind: "failed" } },
      { id: "i3", error: { kind: "gone" } },
    ],
  });

  assert.deepEqual(globalThis.__toasts, [
    {
      title: `${INVITATIONS}resentPartial#1`,
      description: `${INVITATIONS}resendFailedOne#${BOB}`,
    },
    { title: `${INVITATIONS}noLongerPending#${CLEO}` },
  ]);
  assert.equal(ariaChecked(container, `${SELECT_ROW}${BOB}`), "true");
});

test("everything still listed failing keeps the failure toast beside a row that left", async (t) => {
  const { Tab } = await loadTab(t);
  const rows = twoRows();

  await resendAll(t, Tab, rows, [rows[0]], {
    done: [],
    noEmail: [],
    failed: [
      { id: "i1", error: { kind: "failed" } },
      { id: "i2", error: { kind: "gone" } },
    ],
  });

  assert.deepEqual(globalThis.__toasts, [
    { title: `${INVITATIONS}resendFailedAll#1`, variant: "destructive" },
    { title: `${INVITATIONS}noLongerPending#${BOB}` },
  ]);
});

test("a reload that failed reports the failures as before", async (t) => {
  const { Tab } = await loadTab(t);

  await resendAll(t, Tab, twoRows(), null, {
    done: ["i1"],
    noEmail: [],
    failed: [{ id: "i2", error: { kind: "gone" } }],
  });

  assert.deepEqual(globalThis.__toasts, [
    {
      title: `${INVITATIONS}resentPartial#1`,
      description: `${INVITATIONS}resendFailedOne#${BOB}`,
    },
  ]);
  assert.deepEqual(globalThis.__memberRefreshes, []);
});

test("a bulk resend stopped by a rate limit says so", async (t) => {
  const { Tab } = await loadTab(t);
  const rows = twoRows();
  const limited = { error: { kind: "rateLimited" } };

  const container = await resendAll(t, Tab, rows, rows, {
    done: [],
    noEmail: [],
    failed: [
      { id: "i1", ...limited },
      { id: "i2", ...limited },
    ],
  });
  assert.deepEqual(globalThis.__toasts, [{ title: RATE_LIMITED, variant: "destructive" }]);
  assert.equal(selectedCount(container), 2);

  globalThis.__toasts.length = 0;
  globalThis.__bulkResendImpl = async () => ({
    done: ["i1"],
    noEmail: [],
    failed: [{ id: "i2", ...limited }],
  });
  await React.act(async () => propsOf(barButton(container, "resendSelected")).onClick());
  assert.deepEqual(globalThis.__toasts, [
    { title: `${INVITATIONS}resentPartial#1`, description: RATE_LIMITED },
  ]);
});

test("a single resend stopped by a rate limit says so", async (t) => {
  const { Tab, CloudApiError } = await loadTab(t);
  globalThis.__resendImpl = async () => {
    throw new CloudApiError("Too many invitations right now.", 429, "rate_limited");
  };
  const container = await mount(t, Tab, ready([invitation("i1", "ada@example.com", inDays(3))]));

  await React.act(async () => propsOf(menuItem(container, "invitations.resend")).onClick());

  assert.deepEqual(globalThis.__toasts, [
    { title: "common.error", description: RATE_LIMITED, variant: "destructive" },
  ]);
});
