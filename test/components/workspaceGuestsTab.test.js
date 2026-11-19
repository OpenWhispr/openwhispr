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

const KEY = "settingsPage.workspace.guests";

const capabilities = (manageMembers) => ({
  manage_members: manageMembers,
  manage_teams: false,
  create_teams: false,
  create_spaces: false,
  manage_settings: false,
  manage_billing: false,
  delete_workspace: false,
  transfer_ownership: false,
  leave: true,
});

const ADMIN = { id: "w1", name: "Acme", role: "admin", capabilities: capabilities(true) };
const MEMBER = { id: "w1", name: "Acme", role: "member", capabilities: capabilities(false) };

const note = (id, title, overrides = {}) => ({
  id,
  title,
  permission: "viewer",
  visibility: "invited",
  ...overrides,
});
const guest = (email, name, notes = []) => ({ email, name, image: null, notes });

const mountedRoots = new Map();

async function loadTab(
  t,
  { workspace = ADMIN, status = "ready", guests = [], error = { kind: "failed" } } = {}
) {
  t.after(async () => {
    const root = mountedRoots.get(t);
    mountedRoots.delete(t);
    if (root) await React.act(async () => root.unmount());
  });
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-workspace-guests-tab-",
    noExternal: ["react-i18next"],
    mockModules: {
      "/i18n": "export default { t: (key) => key };",
      "react-i18next": `
        export const useTranslation = () => ({
          t: (key, options) =>
            options
              ? key + "|" + Object.entries(options).map(([name, value]) => name + "=" + value).join(",")
              : key,
        });
      `,
      "/hooks/useWorkspaceGuests": `
        export const useWorkspaceGuests = (workspaceId) => {
          globalThis.__guestsArgs = workspaceId;
          return globalThis.__guestsState;
        };
      `,
      "/MemberAvatar": `
        import React from "react";
        export default function MemberAvatar({ name, email }) {
          return React.createElement("span", { "data-avatar": name ?? email });
        }
      `,
      // The menu renders open, so a test reads its notes.
      "/ui/dropdown-menu": `
        import React from "react";
        const h = React.createElement;
        export const DropdownMenu = ({ children }) => h("div", { "data-menu": "" }, children);
        export const DropdownMenuTrigger = ({ children, "aria-label": label }) =>
          h("button", { "data-trigger": "", "aria-label": label }, children);
        export const DropdownMenuContent = ({ children, onCloseAutoFocus, ref }) =>
          h("div", { ref, "data-menu-content": "", onCloseAutoFocus }, children);
        export const DropdownMenuItem = ({ children, onSelect, asChild, ...rest }) =>
          asChild
            ? React.cloneElement(children, { "data-item": "", onSelect })
            : h("button", { "data-item": "", onSelect, ...rest }, children);
      `,
      "/lib/workspaceErrors": `
        export const classifyRowActionError = (error) =>
          error.rowKind ? { kind: error.rowKind, message: error.message } : { kind: "failed" };
      `,
      "/services/GuestsService": `
        export const GuestsService = {
          remove: (workspaceId, input) => {
            globalThis.__removeCalls.push([workspaceId, input]);
            return globalThis.__removeImpl(workspaceId, input);
          },
        };
      `,
      "/ui/useToast": `
        export const useToast = () => ({ toast: (toast) => globalThis.__toasts.push(toast) });
      `,
      "/InviteTeammateDialog": `
        import React from "react";
        export default function InviteTeammateDialog(props) {
          globalThis.__inviteProps = props;
          React.useEffect(() => {
            globalThis.__inviteMounted = true;
            globalThis.__inviteMounts = (globalThis.__inviteMounts ?? 0) + 1;
            return () => {
              globalThis.__inviteMounted = false;
            };
          }, []);
          return null;
        }
      `,
      "/workspace/RemoveGuestsDialog": `
        export function RemoveGuestsDialog(props) {
          globalThis.__removeProps = props;
          return null;
        }
      `,
    },
  });
  const module = await vite.ssrLoadModule("/components/settings/WorkspaceGuestsTab.tsx");
  t.after(() => {
    delete globalThis.__guestsState;
    delete globalThis.__guestsArgs;
    delete globalThis.__reloads;
    delete globalThis.__dropped;
    delete globalThis.__droppedNotes;
    delete globalThis.__removeCalls;
    delete globalThis.__removeImpl;
    delete globalThis.__toasts;
    delete globalThis.__inviteProps;
    delete globalThis.__inviteMounted;
    delete globalThis.__inviteMounts;
    delete globalThis.__removeProps;
    delete globalThis.__clipboard;
  });
  globalThis.__reloads = 0;
  globalThis.__dropped = [];
  globalThis.__droppedNotes = [];
  globalThis.__removeCalls = [];
  globalThis.__removeImpl = async (_workspaceId, input) => ({
    removed: input.emails,
    not_found: [],
    skipped_members: [],
    link_shared_note_ids: [],
  });
  globalThis.__toasts = [];
  globalThis.__clipboard = [];
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { clipboard: { writeText: async (text) => void globalThis.__clipboard.push(text) } },
  });
  globalThis.__guestsState = {
    status,
    guests,
    error: status === "failed" ? error : null,
    reload: async () => {
      globalThis.__reloads += 1;
    },
    dropGuests: (emails) => globalThis.__dropped.push(emails),
    dropGuestNote: (email, noteId) => globalThis.__droppedNotes.push([email, noteId]),
  };
  return { Tab: module.default, workspace };
}

const render = (Tab, workspace) => renderToStaticMarkup(React.createElement(Tab, { workspace }));

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

test("shows the empty state", async (t) => {
  const { Tab, workspace } = await loadTab(t, { guests: [] });
  const markup = render(Tab, workspace);
  assert.match(markup, new RegExp(`${KEY}\\.emptyTitle`));
  assert.match(markup, new RegExp(`${KEY}\\.emptyBody`));
  assert.doesNotMatch(markup, /<table/);
});

test("shows the loading state inside the table frame", async (t) => {
  const { Tab, workspace } = await loadTab(t, { status: "loading" });
  const markup = render(Tab, workspace);
  assert.match(markup, /<table/);
  assert.match(markup, new RegExp(`${KEY}\\.loadingTitle`));
  assert.match(markup, new RegExp(`${KEY}\\.loadingBody`));
});

test("lists name, email and note count", async (t) => {
  const { Tab, workspace } = await loadTab(t, {
    guests: [guest("jin@x.com", "Jin Park", [note("n1", "Plan"), note("n2", "Notes")])],
  });
  const markup = render(Tab, workspace);
  assert.match(markup, new RegExp(`${KEY}\\.columns\\.name`));
  assert.match(markup, new RegExp(`${KEY}\\.columns\\.access`));
  assert.match(markup, /Jin Park/);
  assert.match(markup, /<bdi dir="ltr">jin@x\.com<\/bdi>/);
  assert.match(markup, new RegExp(`${KEY}\\.noteCount\\|count=2`));
  assert.equal(globalThis.__guestsArgs, "w1");
});

test("a guest without a name shows the email once", async (t) => {
  const { Tab, workspace } = await loadTab(t, {
    guests: [guest("ravi@x.com", null, [note("n1", "Plan")])],
  });
  // Visible text only: the menu trigger's accessible name legitimately carries the name too.
  const visible = render(Tab, workspace).replace(/ (aria-label|data-avatar)="[^"]*"/g, "");
  assert.equal(visible.split("ravi@x.com").length - 1, 1);
});

test("the Access menu lists titles, untitled ones as Untitled", async (t) => {
  const { Tab, workspace } = await loadTab(t, {
    guests: [
      guest("jin@x.com", "Jin", [note("n1", "Roadmap"), note("n2", null), note("n3", "  ")]),
    ],
  });
  const markup = render(Tab, workspace);
  assert.match(markup, /dir="auto"[^>]*>Roadmap</);
  assert.equal(markup.split(">notes.list.untitled<").length - 1, 2);
  assert.match(markup, new RegExp(`${KEY}\\.notesTriggerLabel\\|count=3,name=`));
});

test("a failed load shows Failed", async (t) => {
  const { Tab, workspace } = await loadTab(t, { status: "failed" });
  const markup = render(Tab, workspace);
  assert.match(markup, new RegExp(`${KEY}\\.failedTitle`));
  assert.match(markup, new RegExp(`${KEY}\\.failedBody`));
});

test("Try again reloads", async (t) => {
  const { Tab, workspace } = await loadTab(t, { status: "failed" });
  const container = installHostDom(t);
  const root = createRoot(container);
  mountedRoots.set(t, root);
  await React.act(async () => root.render(React.createElement(Tab, { workspace })));
  const retry = findNode(
    container,
    (node) => node.tagName === "BUTTON" && textOf(node).trim() === "workspaces.exit.tryAgain"
  );
  assert.ok(retry, "Failed offers Try again");
  await React.act(async () => propsOf(retry).onClick());
  assert.equal(globalThis.__reloads, 1);
});

test("without manage_members there are no checkboxes, no Actions and no ×", async (t) => {
  const { Tab, workspace } = await loadTab(t, {
    workspace: MEMBER,
    guests: [guest("jin@x.com", "Jin", [note("n1", "Plan")])],
  });
  const markup = render(Tab, workspace);
  assert.match(markup, /Jin/);
  assert.doesNotMatch(markup, /type="checkbox"/);
  assert.doesNotMatch(markup, new RegExp(`${KEY}\\.columns\\.actions`));
  assert.doesNotMatch(markup, new RegExp(`${KEY}\\.removeFromNote`));
});

const JIN = guest("jin@x.com", "Jin Park", [note("n1", "Plan", { visibility: "link" })]);

async function mountTab(t, { props = {}, ...options } = {}) {
  const { Tab, workspace } = await loadTab(t, options);
  const container = installHostDom(t);
  const root = createRoot(container);
  mountedRoots.set(t, root);
  await React.act(async () => root.render(React.createElement(Tab, { workspace, ...props })));
  const rerender = () =>
    React.act(async () => root.render(React.createElement(Tab, { workspace, ...props })));
  const item = (label) =>
    findNode(container, (node) => node.hasAttribute("data-item") && textOf(node).trim() === label);
  return { container, item, rerender };
}

test("the row menu offers invite, copy and remove", async (t) => {
  const { Tab, workspace } = await loadTab(t, { guests: [JIN] });
  const markup = render(Tab, workspace);
  assert.match(markup, new RegExp(`${KEY}\\.columns\\.actions`));
  assert.match(markup, new RegExp(`${KEY}\\.menu\\.label\\|name=`));
  for (const key of ["invite", "copyEmail", "remove"]) {
    assert.match(markup, new RegExp(`${KEY}\\.menu\\.${key}`));
  }
});

test("copy writes the email and toasts", async (t) => {
  const { item } = await mountTab(t, { guests: [JIN] });
  await React.act(async () => propsOf(item(`${KEY}.menu.copyEmail`)).onSelect());
  assert.deepEqual(globalThis.__clipboard, ["jin@x.com"]);
  assert.equal(globalThis.__toasts[0].title, "common.copied");
});

test("invite opens the dialog with the guest's address and the guest heading", async (t) => {
  const { item } = await mountTab(t, { guests: [JIN] });
  assert.equal(globalThis.__inviteProps, undefined);
  await React.act(async () => propsOf(item(`${KEY}.menu.invite`)).onSelect());
  const props = globalThis.__inviteProps;
  assert.equal(props.open, true);
  assert.equal(props.workspaceId, "w1");
  assert.equal(props.workspaceName, "Acme");
  assert.deepEqual(props.initialEmails, ["jin@x.com"]);
  assert.match(props.heading.title, new RegExp(`${KEY}\\.invite\\.title\\|count=1`));
  assert.match(props.heading.description, new RegExp(`${KEY}\\.invite\\.description`));
});

test("a send reloads the list and closing leaves the toast to the dialog", async (t) => {
  let refreshed = 0;
  const { item } = await mountTab(t, {
    guests: [JIN],
    props: { onInvitationsChanged: () => void refreshed++ },
  });
  await React.act(async () => propsOf(item(`${KEY}.menu.invite`)).onSelect());
  await React.act(async () => globalThis.__inviteProps.onInvitationsChanged());
  assert.equal(globalThis.__reloads, 1);
  assert.equal(refreshed, 1);
  await React.act(async () => globalThis.__inviteProps.onInvited(["jin@x.com"]));
  await React.act(async () => globalThis.__inviteProps.onOpenChange(false));
  // The dialog toasts its own sends; a second toast here would repeat it.
  assert.equal(globalThis.__toasts.length, 0);
});

test("closing the invite without sending doesn't toast", async (t) => {
  const { item } = await mountTab(t, { guests: [JIN] });
  await React.act(async () => propsOf(item(`${KEY}.menu.invite`)).onSelect());
  await React.act(async () => globalThis.__inviteProps.onOpenChange(false));
  assert.equal(globalThis.__toasts.length, 0);
});

test("removed guests leave the list at once, ahead of the reload", async (t) => {
  const { item } = await mountTab(t, { guests: [JIN] });
  await React.act(async () => propsOf(item(`${KEY}.menu.remove`)).onSelect());
  assert.deepEqual(
    globalThis.__removeProps.guests.map((g) => g.email),
    ["jin@x.com"]
  );
  await React.act(async () =>
    globalThis.__removeProps.onRemoved({
      removed: ["jin@x.com"],
      not_found: [],
      skipped_members: [],
      link_shared_note_ids: [],
    })
  );
  // Dropped by the hook before the reload, so a failing reload can't leave them listed.
  assert.deepEqual(globalThis.__dropped, [["jin@x.com"]]);
  assert.equal(globalThis.__reloads, 1);
});

const TWO = guest("jin@x.com", "Jin Park", [note("n1", "Plan"), note("n2", "Roadmap")]);
const REMOVE_LABEL = `${KEY}.removeFromNote`;
function collect(node, predicate, found = []) {
  if (node.nodeType === 1 && predicate(node)) found.push(node);
  for (const child of node.childNodes ?? []) collect(child, predicate, found);
  return found;
}
const removeButtons = (container) =>
  collect(
    container,
    (node) =>
      node.hasAttribute("data-item") &&
      (node.getAttribute("aria-label") ?? "").startsWith(REMOVE_LABEL)
  );

test("the × removes that note only", async (t) => {
  const { container } = await mountTab(t, { guests: [TWO] });
  const buttons = removeButtons(container);
  assert.equal(buttons.length, 2);
  assert.match(buttons[1].getAttribute("aria-label"), /note=\u2068Roadmap\u2069/);
  const event = {
    preventDefault() {
      this.prevented = true;
    },
  };
  await React.act(async () => propsOf(buttons[1]).onSelect(event));
  assert.equal(event.prevented, true, "the menu stays open");
  assert.deepEqual(globalThis.__removeCalls, [["w1", { emails: ["jin@x.com"], note_id: "n2" }]]);
  assert.deepEqual(globalThis.__droppedNotes, [["jin@x.com", "n2"]]);
  assert.equal(globalThis.__reloads, 1);
  assert.match(globalThis.__toasts[0].title, new RegExp(`${KEY}\\.removedFromNote\\|`));
  assert.match(globalThis.__toasts[0].title, /note=\u2068Roadmap\u2069/);
});

test("a second press while sending does nothing", async (t) => {
  let release;
  const { container } = await mountTab(t, { guests: [TWO] });
  globalThis.__removeImpl = (_w, input) =>
    new Promise((resolve) => {
      release = () =>
        resolve({
          removed: input.emails,
          not_found: [],
          skipped_members: [],
          link_shared_note_ids: [],
        });
    });
  const button = removeButtons(container)[0];
  const event = { preventDefault() {} };
  await React.act(async () => void propsOf(button).onSelect(event));
  await React.act(async () => void propsOf(button).onSelect(event));
  assert.equal(globalThis.__removeCalls.length, 1);
  await React.act(async () => release());
  assert.equal(globalThis.__reloads, 1);
});

test("a failure keeps the note and toasts", async (t) => {
  const { container } = await mountTab(t, { guests: [TWO] });
  globalThis.__removeImpl = async () => {
    throw new Error("offline");
  };
  await React.act(async () =>
    propsOf(removeButtons(container)[0]).onSelect({ preventDefault() {} })
  );
  assert.deepEqual(globalThis.__droppedNotes, []);
  assert.equal(globalThis.__reloads, 0);
  assert.match(globalThis.__toasts[0].title, new RegExp(`${KEY}\\.removeFromNoteFailed\\|`));
  assert.equal(globalThis.__toasts[0].variant, "destructive");
  // The item is usable again.
  await React.act(async () =>
    propsOf(removeButtons(container)[0]).onSelect({ preventDefault() {} })
  );
  assert.equal(globalThis.__removeCalls.length, 2);
});

test("a guest the server skipped isn't toasted as removed", async (t) => {
  const { container } = await mountTab(t, { guests: [TWO] });
  globalThis.__removeImpl = async () => ({
    removed: [],
    not_found: [],
    skipped_members: ["JIN@x.com"],
    link_shared_note_ids: [],
  });
  await React.act(async () =>
    propsOf(removeButtons(container)[0]).onSelect({ preventDefault() {} })
  );
  assert.deepEqual(globalThis.__droppedNotes, []);
  assert.equal(globalThis.__toasts.length, 0);
  assert.equal(globalThis.__reloads, 1);
});

test("removing a guest's last note drops the row and keeps focus in the table", async (t) => {
  const { container } = await mountTab(t, { guests: [JIN] });
  await React.act(async () =>
    propsOf(removeButtons(container)[0]).onSelect({ preventDefault() {} })
  );
  assert.deepEqual(globalThis.__droppedNotes, [["jin@x.com", "n1"]]);
  const frame = findNode(container, (node) => node.hasAttribute("data-guests-table"));
  assert.ok(frame, "the table frame can take focus");
  let focused = 0;
  frame.focus = () => void focused++;
  const content = findNode(container, (node) => node.hasAttribute("data-menu-content"));
  const event = {
    preventDefault() {
      this.prevented = true;
    },
  };
  propsOf(content).onCloseAutoFocus(event);
  assert.equal(event.prevented, true);
  assert.equal(focused, 1);
});

test("a menu that still has notes returns focus to its trigger", async (t) => {
  const { container } = await mountTab(t, { guests: [TWO] });
  await React.act(async () =>
    propsOf(removeButtons(container)[0]).onSelect({ preventDefault() {} })
  );
  const content = findNode(container, (node) => node.hasAttribute("data-menu-content"));
  const event = {
    preventDefault() {
      this.prevented = true;
    },
  };
  propsOf(content).onCloseAutoFocus(event);
  assert.equal(event.prevented, undefined);
});

const THREE = guest("jin@x.com", "Jin Park", [
  note("n1", "Plan"),
  note("n2", "Roadmap"),
  note("n3", "Budget"),
]);

async function removeAndRerender(t, notes, pressedIndex) {
  const { Tab, workspace } = await loadTab(t, { guests: [guest("jin@x.com", "Jin Park", notes)] });
  const container = installHostDom(t);
  const root = createRoot(container);
  mountedRoots.set(t, root);
  const mount = () => React.act(async () => root.render(React.createElement(Tab, { workspace })));
  await mount();
  const buttons = removeButtons(container);
  const focused = [];
  buttons.forEach((node, index) => (node.focus = () => focused.push(`button${index}`)));
  const content = findNode(container, (node) => node.hasAttribute("data-menu-content"));
  content.focus = () => focused.push("content");
  await React.act(async () => propsOf(buttons[pressedIndex]).onSelect({ preventDefault() {} }));
  // The hook has dropped the note by now.
  globalThis.__guestsState.guests = [
    guest(
      "jin@x.com",
      "Jin Park",
      notes.filter((_, index) => index !== pressedIndex)
    ),
  ];
  await mount();
  return focused;
}

test("removing a middle note moves focus to the next note's ×", async (t) => {
  const notes = THREE.notes;
  const focused = await removeAndRerender(t, notes, 1);
  // button2 (Budget) survives the rerender as the same node, so index 2 is the next ×.
  assert.deepEqual(focused, ["button2"]);
});

test("removing the last note in the list moves focus to the previous ×", async (t) => {
  const focused = await removeAndRerender(t, THREE.notes, 2);
  assert.deepEqual(focused, ["button1"]);
});

const RAVI = guest("ravi@x.com", null, [note("n9", "Budget")]);
const SEL = `${KEY}.selection`;
const EMPTY_REMOVAL = { removed: [], not_found: [], skipped_members: [], link_shared_note_ids: [] };

async function mountSelectable(t, options) {
  const { Tab, workspace } = await loadTab(t, options);
  const container = installHostDom(t);
  const root = createRoot(container);
  mountedRoots.set(t, root);
  const mount = () => React.act(async () => root.render(React.createElement(Tab, { workspace })));
  await mount();
  const checkboxes = () => collect(container, (node) => node.getAttribute("role") === "checkbox");
  const rowBoxes = () => checkboxes().slice(1);
  const headerBox = () => checkboxes()[0];
  const barButton = (label) =>
    findNode(
      container,
      (node) => node.tagName === "BUTTON" && textOf(node).trim() === `${SEL}.${label}`
    );
  const click = (node) => React.act(async () => propsOf(node).onClick({ shiftKey: false }));
  return { container, mount, checkboxes, rowBoxes, headerBox, barButton, click };
}

test("selecting shows the bar with both actions", async (t) => {
  const view = await mountSelectable(t, { guests: [JIN, RAVI] });
  assert.equal(view.barButton("invite"), null, "no bar until something is selected");
  await view.click(view.rowBoxes()[0]);
  assert.ok(view.barButton("invite"));
  assert.ok(view.barButton("remove"));
  assert.match(textOf(view.container), /people\.selection\.count\|count=1/);
});

test("invite opens with every selected address", async (t) => {
  const view = await mountSelectable(t, { guests: [JIN, RAVI] });
  await view.click(view.headerBox());
  await view.click(view.barButton("invite"));
  const props = globalThis.__inviteProps;
  assert.deepEqual(props.initialEmails, ["jin@x.com", "ravi@x.com"]);
  assert.match(props.heading.title, new RegExp(`${KEY}\\.invite\\.title\\|count=2`));
});

test("a send clears the selection without a second toast", async (t) => {
  const view = await mountSelectable(t, { guests: [JIN, RAVI] });
  await view.click(view.headerBox());
  await view.click(view.barButton("invite"));
  await React.act(async () => globalThis.__inviteProps.onInvited(["jin@x.com", "ravi@x.com"]));
  await React.act(async () => globalThis.__inviteProps.onOpenChange(false));
  assert.equal(globalThis.__toasts.length, 0);
  assert.equal(view.barButton("invite"), null);
});

test("closing the invite without sending keeps the selection", async (t) => {
  const view = await mountSelectable(t, { guests: [JIN, RAVI] });
  await view.click(view.headerBox());
  await view.click(view.barButton("invite"));
  await React.act(async () => globalThis.__inviteProps.onOpenChange(false));
  assert.ok(view.barButton("invite"));
});

test("remove removes the selected and clears", async (t) => {
  const view = await mountSelectable(t, { guests: [JIN, RAVI] });
  await view.click(view.headerBox());
  await view.click(view.barButton("remove"));
  assert.deepEqual(
    globalThis.__removeProps.guests.map((g) => g.email),
    ["jin@x.com", "ravi@x.com"]
  );
  await React.act(async () =>
    globalThis.__removeProps.onRemoved({
      ...EMPTY_REMOVAL,
      removed: ["jin@x.com", "ravi@x.com"],
    })
  );
  assert.deepEqual(globalThis.__dropped, [["jin@x.com", "ravi@x.com"]]);
  assert.equal(globalThis.__reloads, 1);
  assert.equal(view.barButton("remove"), null);
});

test("skipped members aren't counted as removed", async (t) => {
  const view = await mountSelectable(t, { guests: [JIN, RAVI] });
  await view.click(view.headerBox());
  await view.click(view.barButton("remove"));
  await React.act(async () =>
    globalThis.__removeProps.onRemoved({
      ...EMPTY_REMOVAL,
      removed: ["jin@x.com"],
      skipped_members: ["ravi@x.com"],
    })
  );
  // Only the removed one is dropped; the member leaves through the reload.
  assert.deepEqual(globalThis.__dropped, [["jin@x.com"]]);
  assert.equal(globalThis.__reloads, 1);
});

test("a failure keeps the selection", async (t) => {
  const view = await mountSelectable(t, { guests: [JIN, RAVI] });
  await view.click(view.headerBox());
  await view.click(view.barButton("remove"));
  // The dialog reports failures itself and never calls onRemoved; closing it keeps the selection.
  await React.act(async () => globalThis.__removeProps.onOpenChange(false));
  assert.ok(view.barButton("remove"));
  assert.match(textOf(view.container), /people\.selection\.count\|count=2/);
});

test("a reload drops guests that left", async (t) => {
  const view = await mountSelectable(t, { guests: [JIN, RAVI] });
  await view.click(view.headerBox());
  globalThis.__guestsState.guests = [RAVI];
  await view.mount();
  assert.match(textOf(view.container), /people\.selection\.count\|count=1/);
  await view.click(view.barButton("remove"));
  assert.deepEqual(
    globalThis.__removeProps.guests.map((g) => g.email),
    ["ravi@x.com"]
  );
});

test("select-all selects the listed guests only", async (t) => {
  const view = await mountSelectable(t, { guests: [JIN, RAVI] });
  assert.equal(view.headerBox().getAttribute("aria-checked"), "false");
  await view.click(view.rowBoxes()[0]);
  assert.equal(view.headerBox().getAttribute("aria-checked"), "mixed");
  await view.click(view.headerBox());
  assert.deepEqual(
    view.rowBoxes().map((box) => box.getAttribute("aria-checked")),
    ["true", "true"]
  );
  await view.click(view.headerBox());
  assert.deepEqual(
    view.rowBoxes().map((box) => box.getAttribute("aria-checked")),
    ["false", "false"]
  );
});

test("inviting the last listed guests keeps the dialog until it closes", async (t) => {
  const { item, rerender } = await mountTab(t, { guests: [JIN] });
  await React.act(async () => propsOf(item(`${KEY}.menu.invite`)).onSelect());
  assert.equal(globalThis.__inviteMounted, true);
  await React.act(async () => globalThis.__inviteProps.onInvited(["jin@x.com"]));
  // The send moved the guest to Invitations, so the reload comes back empty.
  globalThis.__guestsState.guests = [];
  await rerender();
  assert.equal(globalThis.__inviteMounted, true, "the Sent screen is still showing");
  // A remount would reset the dialog to its form; mounted once means its Sent state survived.
  assert.equal(globalThis.__inviteMounts, 1);
  await React.act(async () => globalThis.__inviteProps.onOpenChange(false));
  assert.equal(globalThis.__inviteMounted, false);
});

test("members' notes are menu items that do nothing", async (t) => {
  const { container } = await mountTab(t, { workspace: MEMBER, guests: [TWO] });
  const rows = collect(container, (node) => node.hasAttribute("data-item"));
  assert.deepEqual(
    rows.map((node) => textOf(node).trim()),
    ["Plan", "Roadmap"]
  );
  const event = {
    preventDefault() {
      this.prevented = true;
    },
  };
  propsOf(rows[0]).onSelect(event);
  assert.equal(event.prevented, true);
  assert.equal(globalThis.__removeCalls.length, 0);
});

test("Failed for an SSO workspace says so and offers no Try again", async (t) => {
  const { container } = await mountTab(t, { status: "failed", error: { kind: "ssoRequired" } });
  assert.match(textOf(container), /workspaces\.ssoRequired\|workspace=\u2068Acme\u2069/);
  assert.doesNotMatch(textOf(container), /workspaces\.exit\.tryAgain/);
  assert.doesNotMatch(textOf(container), new RegExp(`${KEY}\\.failedBody`));
});

async function failWith(t, error) {
  const { container } = await mountTab(t, { guests: [TWO] });
  globalThis.__removeImpl = async () => {
    throw error;
  };
  await React.act(async () =>
    propsOf(removeButtons(container)[0]).onSelect({ preventDefault() {} })
  );
}

const toastsAfter = async (t, rowKind, message = "x") => {
  await failWith(t, Object.assign(new Error(message), { rowKind }));
  return globalThis.__toasts;
};

test("a × refused for permission names that, not the connection", async (t) => {
  const toasts = await toastsAfter(t, "notAllowed");
  assert.match(toasts[0].title, /workspaces\.removeMember\.notAllowed\|workspace=\u2068Acme\u2069/);
  assert.equal(toasts[0].variant, "destructive");
});

test("a × refused for SSO says to sign in with SSO", async (t) => {
  const toasts = await toastsAfter(t, "ssoRequired");
  assert.match(toasts[0].title, /workspaces\.ssoRequired\|workspace=/);
});

test("a × the server refused shows its reason", async (t) => {
  const toasts = await toastsAfter(t, "refused", "Not today");
  assert.equal(toasts[0].title, "Not today");
});

test("a connection failure still blames the connection", async (t) => {
  const toasts = await toastsAfter(t, "failed");
  assert.match(toasts[0].title, new RegExp(`${KEY}\\.removeFromNoteFailed\\|`));
});

test("inviting one guest from its row keeps the rest of the selection", async (t) => {
  const view = await mountSelectable(t, { guests: [JIN, RAVI] });
  await view.click(view.headerBox());
  const rowMenuInvite = findNode(
    view.container,
    (node) => node.hasAttribute("data-item") && textOf(node).trim() === `${KEY}.menu.invite`
  );
  await React.act(async () => propsOf(rowMenuInvite).onSelect());
  assert.deepEqual(globalThis.__inviteProps.initialEmails, ["jin@x.com"]);
  await React.act(async () => globalThis.__inviteProps.onInvited(["jin@x.com"]));
  await React.act(async () => globalThis.__inviteProps.onOpenChange(false));
  assert.match(textOf(view.container), /people\.selection\.count\|count=1/);
});

test("removing one guest from its row keeps the rest of the selection", async (t) => {
  const view = await mountSelectable(t, { guests: [JIN, RAVI] });
  await view.click(view.headerBox());
  const rowMenuRemove = findNode(
    view.container,
    (node) => node.hasAttribute("data-item") && textOf(node).trim() === `${KEY}.menu.remove`
  );
  await React.act(async () => propsOf(rowMenuRemove).onSelect());
  await React.act(async () =>
    globalThis.__removeProps.onRemoved({ ...EMPTY_REMOVAL, removed: ["jin@x.com"] })
  );
  assert.match(textOf(view.container), /people\.selection\.count\|count=1/);
});
