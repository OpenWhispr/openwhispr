const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHostDom,
} = require("../lib/rendererTestHarness");

const WORKSPACE = { id: "w1", name: "Acme" };
const member = (user_id, name, role = "member") => ({
  user_id,
  name,
  email: `${user_id.slice(2)}@example.com`,
  role,
  joined_at: "2026-01-01",
  image: null,
});
const SELF = member("u-self", "Ronnie", "admin");
const OWNER = member("u-owner", "Bea", "owner");
const LIAM = member("u-liam", "Liam");
const ALEX = member("u-alex", "Alex");
const ZOE = member("u-zoe", "Zoe");
const ROSTER = [SELF, OWNER, LIAM, ALEX, ZOE];

const owns = (user_id, owned_notes = 1, owned_spaces = 0) => ({
  user_id,
  owned_notes,
  owned_spaces,
});
const preview = (members) => ({ members, already_removed: [], transfer_required: false });
const isolated = (value) => `⁨${value}⁩`;

const pickerText = (text) => text.match(/‹([^›]*)›/)?.[1] ?? null;
const menuItems = (text) => [...text.matchAll(/«([^»]*)»/g)].map((match) => match[1]);

function textOf(node) {
  if (node.nodeType === 3) return node.nodeValue;
  return [...node.childNodes].map(textOf).join("");
}

const GLOBALS = [
  "__actionDialogProps",
  "__menuContentProps",
  "__menuItems",
  "__triggerProps",
  "__toasts",
  "__previewCalls",
  "__previewImpl",
  "__removeCalls",
  "__removeImpl",
  "__refreshMembersCalls",
];

async function loadDialog(t) {
  // Registered before the browser globals, so roots unmount while `window` still exists.
  const roots = [];
  t.after(async () => {
    for (const root of roots) await React.act(async () => root.unmount());
    for (const key of GLOBALS) delete globalThis[key];
  });
  installBrowserGlobals(t);
  globalThis.__toasts = [];
  globalThis.__previewCalls = [];
  globalThis.__previewImpl = async () => preview([]);
  globalThis.__removeCalls = [];
  globalThis.__removeImpl = async () => ({ removed: [], already_removed: [], transferred: null });
  globalThis.__refreshMembersCalls = [];
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-remove-members-dialog-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `
        export function useTranslation() {
          return { t: (key, params) => (params ? key + "|" + JSON.stringify(params) : key) };
        }
      `,
      "/ui/useToast": `
        export const useToast = () => ({ toast: (toast) => globalThis.__toasts.push(toast) });
      `,
      "/stores/workspaceStore": `
        const store = {
          refreshMembers: async (workspaceId) => {
            globalThis.__refreshMembersCalls.push(workspaceId);
          },
        };
        export const useWorkspaceStore = (selector) => selector(store);
      `,
      "/services/WorkspacesService": `
        export const WorkspacesService = {
          previewMemberRemoval: (workspaceId, userIds) => {
            globalThis.__previewCalls.push([workspaceId, userIds]);
            return globalThis.__previewImpl();
          },
        };
      `,
      "/services/workspaceActions": `
        export const removeMembers = (workspaceId, input) => {
          globalThis.__removeCalls.push([workspaceId, input]);
          return globalThis.__removeImpl();
        };
      `,
      "/MemberAvatar": "export default function MemberAvatar() { return null; }",
      "/ui/dropdown-menu": `
        import React from "react";
        const passThrough = ({ children }) => React.createElement(React.Fragment, null, children);
        export const DropdownMenu = passThrough;
        export const DropdownMenuContent = (props) => {
          globalThis.__menuContentProps = props;
          globalThis.__menuItems = [];
          return React.createElement("div", { role: "menu" }, props.children);
        };
        export const DropdownMenuTrigger = (props) => {
          globalThis.__triggerProps = props;
          return React.createElement("button", null, "‹", props.children, "›");
        };
        export const DropdownMenuItem = ({ children, onSelect }) => {
          globalThis.__menuItems.push(onSelect);
          return React.createElement("div", { role: "menuitem" }, "«", children, "»");
        };
      `,
      "/WorkspaceActionDialog": `
        import React from "react";
        export function WorkspaceActionDialog(props) {
          globalThis.__actionDialogProps = props;
          return React.createElement(
            "div",
            null,
            React.createElement("h2", null, props.title),
            React.createElement("p", null, props.body),
            props.children,
            props.error ? React.createElement("p", { role: "alert" }, "!" + props.error) : null,
            React.createElement("button", null, props.primary.label)
          );
        }
      `,
    },
  });
  const { RemoveMembersDialog } = await vite.ssrLoadModule(
    "/components/workspace/RemoveMembersDialog.tsx"
  );
  const { memberRemovalReducer } = await vite.ssrLoadModule("/lib/memberRemovalFlow.ts");
  const { CloudApiError } = await vite.ssrLoadModule("/services/cloudApi.ts");

  // Drives the dialog with the real reducer, as the Members tab does.
  const mount = async (initial) => {
    const events = [];
    const removed = [];
    function Harness() {
      const [state, dispatch] = React.useReducer(memberRemovalReducer, initial);
      const record = React.useCallback((event) => {
        events.push(event);
        dispatch(event);
      }, []);
      return React.createElement(RemoveMembersDialog, {
        workspace: WORKSPACE,
        roster: ROSTER,
        state,
        dispatch: record,
        onRemoved: (ids) => removed.push(ids),
      });
    }
    const container = installHostDom(t);
    const root = createRoot(container);
    roots.push(root);
    await React.act(async () => root.render(React.createElement(Harness)));
    return {
      events,
      removed,
      text: () => textOf(container),
      act: (fn) => React.act(async () => fn()),
      clickPrimary: () => React.act(async () => globalThis.__actionDialogProps.primary.onClick()),
    };
  };
  const opened = (subjects) =>
    memberRemovalReducer({ kind: "closed" }, { type: "open", subjects, defaultOwnerId: "u-self" });
  return { mount, opened, CloudApiError };
}

test("two members without content show the plain confirm", async (t) => {
  const { mount, opened } = await loadDialog(t);
  globalThis.__previewImpl = async () => preview([owns("u-liam", 0, 0), owns("u-alex", 0, 0)]);

  const view = await mount(opened([LIAM, ALEX]));

  assert.deepEqual(globalThis.__previewCalls, [["w1", ["u-liam", "u-alex"]]]);
  const text = view.text();
  assert.match(
    text,
    new RegExp(
      `workspaces\\.removeMembers\\.title\\|\\{"count":2,"workspace":"${isolated("Acme")}"\\}`
    )
  );
  assert.match(text, /workspaces\.removeMember\.body/);
  assert.match(text, /workspaces\.removeMembers\.confirm\|\{"count":2\}/);
  assert.equal(globalThis.__triggerProps, undefined);
  const props = globalThis.__actionDialogProps;
  assert.equal(props.icon, "trash");
  assert.equal(props.primary.tone, "destructive");
  assert.notEqual(props.primary.disabled, true);
  assert.equal(props.cancelLabel, "common.cancel");
});

test("one member without content shows the single-member copy", async (t) => {
  const { mount, opened } = await loadDialog(t);

  const view = await mount(opened([LIAM]));

  const text = view.text();
  assert.match(
    text,
    new RegExp(`workspaces\\.removeMember\\.title\\|\\{"name":"${isolated("Liam")}"`)
  );
  assert.match(text, /workspaces\.removeMember\.confirm/);
});

test("one content owner shows the picker with you chosen", async (t) => {
  const { mount, opened } = await loadDialog(t);
  globalThis.__previewImpl = async () => preview([owns("u-liam", 3, 1)]);

  const view = await mount(opened([LIAM]));

  const text = view.text();
  assert.match(
    text,
    new RegExp(`workspaces\\.removeMembers\\.ownerOne\\|\\{"name":"${isolated("Liam")}"\\}`)
  );
  assert.match(text, /workspaces\.removeMembers\.transferBody/);
  assert.match(text, /workspaces\.removeMembers\.transferConfirm/);
  assert.equal(globalThis.__triggerProps["aria-label"], "workspaces.removeMembers.transferLabel");
  assert.equal(pickerText(text), `workspaces.removeMembers.you|{"name":"${isolated("Ronnie")}"}`);
  // You first, then everyone not being removed by name, each with their email.
  assert.deepEqual(menuItems(text), [
    `workspaces.removeMembers.you|{"name":"${isolated("Ronnie")}"}self@example.com`,
    "Alexalex@example.com",
    "Beaowner@example.com",
    "Zoezoe@example.com",
  ]);
  assert.equal(globalThis.__menuContentProps.side, "top");
  assert.equal(globalThis.__menuContentProps.avoidCollisions, false);
  assert.match(globalThis.__menuContentProps.className, /max-h-\[min\(16rem,/);
  assert.notEqual(globalThis.__actionDialogProps.primary.disabled, true);
});

test("several content owners are counted", async (t) => {
  const { mount, opened } = await loadDialog(t);
  globalThis.__previewImpl = async () => preview([owns("u-liam", 0, 0), owns("u-alex", 2, 0)]);

  const view = await mount(opened([LIAM, ALEX]));

  assert.match(view.text(), /workspaces\.removeMembers\.owners\|\{"count":1\}/);
});

test("checking shows a disabled primary", async (t) => {
  const { mount, opened } = await loadDialog(t);
  globalThis.__previewImpl = () => new Promise(() => {});

  const view = await mount(opened([LIAM, ALEX]));

  const props = globalThis.__actionDialogProps;
  assert.equal(props.primary.label, "workspaces.removeMembers.checking");
  assert.equal(props.primary.disabled, true);
  assert.equal(props.primary.pending, true);
  assert.match(view.text(), /workspaces\.removeMember\.body/);
});

test("a failed preview offers the plain confirm", async (t) => {
  const { mount, opened } = await loadDialog(t);
  globalThis.__previewImpl = async () => {
    throw new Error("offline");
  };

  const view = await mount(opened([LIAM, ALEX]));

  assert.match(view.text(), /workspaces\.removeMembers\.confirm\|\{"count":2\}/);
});

test("a transfer sends the new owner and toasts the transfer", async (t) => {
  const { mount, opened } = await loadDialog(t);
  globalThis.__previewImpl = async () => preview([owns("u-liam")]);
  globalThis.__removeImpl = async () => ({
    removed: ["u-liam", "u-alex"],
    already_removed: [],
    transferred: { to: "u-zoe", notes: 3, spaces: 0 },
  });
  const view = await mount(opened([LIAM, ALEX]));

  // Candidates: you, Bea, Zoe.
  await view.act(() => globalThis.__menuItems[2]());
  assert.equal(pickerText(view.text()), "Zoe");
  await view.clickPrimary();

  assert.deepEqual(globalThis.__removeCalls, [
    ["w1", { userIds: ["u-liam", "u-alex"], transferTo: "u-zoe" }],
  ]);
  assert.equal(globalThis.__toasts.length, 1);
  assert.equal(
    globalThis.__toasts[0].title,
    `workspaces.removeMembers.transferDone|{"name":"${isolated("Zoe")}","count":2}`
  );
  assert.deepEqual(view.removed, [["u-liam", "u-alex"]]);
  assert.equal(view.text(), "");
});

test("a removal without content sends no new owner and toasts the count", async (t) => {
  const { mount, opened } = await loadDialog(t);
  globalThis.__removeImpl = async () => ({
    removed: ["u-liam"],
    already_removed: ["u-alex"],
    transferred: null,
  });
  const view = await mount(opened([LIAM, ALEX]));

  await view.clickPrimary();

  assert.deepEqual(globalThis.__removeCalls, [["w1", { userIds: ["u-liam", "u-alex"] }]]);
  assert.equal(globalThis.__toasts[0].title, 'workspaces.removeMembers.done|{"count":2}');
  assert.deepEqual(view.removed, [["u-liam", "u-alex"]]);
});

test("removing one member toasts their name", async (t) => {
  const { mount, opened } = await loadDialog(t);
  globalThis.__removeImpl = async () => ({
    removed: ["u-liam"],
    already_removed: [],
    transferred: null,
  });
  const view = await mount(opened([LIAM]));

  await view.clickPrimary();

  assert.equal(
    globalThis.__toasts[0].title,
    `settingsPage.workspace.members.removed|{"name":"${isolated("Liam")}"}`
  );
});

test("a second click while removing sends one request", async (t) => {
  const { mount, opened } = await loadDialog(t);
  let finish;
  globalThis.__removeImpl = () =>
    new Promise((resolve) => {
      finish = () => resolve({ removed: ["u-liam"], already_removed: [], transferred: null });
    });
  const view = await mount(opened([LIAM]));
  const { onClick } = globalThis.__actionDialogProps.primary;

  await view.act(() => {
    onClick();
    onClick();
  });
  assert.equal(globalThis.__actionDialogProps.busy, true);
  assert.equal(globalThis.__actionDialogProps.primary.label, "workspaces.removeMember.removing");
  await view.act(() => finish());

  assert.equal(globalThis.__removeCalls.length, 1);
});

test("transfer failure says no members were removed", async (t) => {
  const { mount, opened } = await loadDialog(t);
  globalThis.__previewImpl = async () => preview([owns("u-liam")]);
  let reject;
  globalThis.__removeImpl = () =>
    new Promise((_, rejectRun) => {
      reject = () => rejectRun(new Error("offline"));
    });
  const view = await mount(opened([LIAM]));

  await view.act(() => globalThis.__actionDialogProps.primary.onClick());
  assert.equal(
    globalThis.__actionDialogProps.primary.label,
    "workspaces.removeMembers.transferring"
  );
  await view.act(() => reject());

  assert.deepEqual(globalThis.__removeCalls, [
    ["w1", { userIds: ["u-liam"], transferTo: "u-self" }],
  ]);
  assert.match(view.text(), /!workspaces\.removeMembers\.transferFailed/);
  assert.equal(globalThis.__actionDialogProps.primary.label, "workspaces.exit.tryAgain");
  assert.equal(globalThis.__actionDialogProps.primary.tone, "destructive");
  assert.equal(globalThis.__toasts.length, 0);
});

test("a retry that finds everyone gone reports them removed", async (t) => {
  const { mount, opened } = await loadDialog(t);
  globalThis.__removeImpl = async () => {
    throw new Error("offline");
  };
  const view = await mount(opened([LIAM, ALEX]));

  await view.clickPrimary();
  assert.match(view.text(), /!workspaces\.removeMembers\.failed\|\{"count":2\}/);

  globalThis.__removeImpl = async () => ({
    removed: [],
    already_removed: ["u-liam", "u-alex"],
    transferred: null,
  });
  await view.clickPrimary();

  assert.equal(globalThis.__removeCalls.length, 2);
  assert.equal(globalThis.__toasts.length, 1);
  assert.equal(globalThis.__toasts[0].title, 'workspaces.removeMembers.alreadyRemoved|{"count":2}');
  assert.deepEqual(view.removed, [["u-liam", "u-alex"]]);
  assert.equal(view.text(), "");
});

test("one member already gone toasts their name", async (t) => {
  const { mount, opened } = await loadDialog(t);
  globalThis.__removeImpl = async () => ({
    removed: [],
    already_removed: ["u-liam"],
    transferred: null,
  });
  const view = await mount(opened([LIAM]));

  await view.clickPrimary();

  assert.equal(
    globalThis.__toasts[0].title,
    `workspaces.removeMember.alreadyRemoved|{"name":"${isolated("Liam")}"}`
  );
  assert.deepEqual(view.removed, [["u-liam"]]);
});

test("a transfer_required answer switches to the picker", async (t) => {
  const { mount, opened, CloudApiError } = await loadDialog(t);
  globalThis.__previewImpl = async () => {
    throw new Error("offline");
  };
  globalThis.__removeImpl = async () => {
    throw new CloudApiError("Transfer required", 409, "transfer_required", {
      members: [owns("u-alex", 0, 1)],
    });
  };
  const view = await mount(opened([LIAM, ALEX]));

  await view.clickPrimary();

  const text = view.text();
  assert.match(text, /workspaces\.removeMembers\.owners\|\{"count":1\}/);
  assert.match(text, /workspaces\.removeMembers\.transferConfirm/);
  assert.doesNotMatch(text, /!/);
});

test("a vanished new owner falls back to you and keeps the dialog open", async (t) => {
  const { mount, opened, CloudApiError } = await loadDialog(t);
  globalThis.__previewImpl = async () => preview([owns("u-liam")]);
  globalThis.__removeImpl = async () => {
    throw new CloudApiError("Invalid transfer target", 400, "invalid_transfer_target");
  };
  const view = await mount(opened([LIAM]));

  // Candidates: you, Alex, Bea, Zoe.
  await view.act(() => globalThis.__menuItems[3]());
  await view.clickPrimary();

  assert.deepEqual(globalThis.__removeCalls, [
    ["w1", { userIds: ["u-liam"], transferTo: "u-zoe" }],
  ]);
  const text = view.text();
  assert.match(
    text,
    new RegExp(`!workspaces\\.removeMembers\\.invalidTarget\\|\\{"name":"${isolated("Zoe")}"\\}`)
  );
  assert.equal(pickerText(text), `workspaces.removeMembers.you|{"name":"${isolated("Ronnie")}"}`);
  assert.deepEqual(globalThis.__refreshMembersCalls, ["w1"]);
  assert.equal(globalThis.__actionDialogProps.primary.label, "workspaces.exit.tryAgain");
});

for (const [error, line] of [
  [
    { kind: "notAllowed" },
    `workspaces.removeMember.notAllowed|{"workspace":"${isolated("Acme")}"}`,
  ],
  [{ kind: "ssoRequired" }, `workspaces.ssoRequired|{"workspace":"${isolated("Acme")}"}`],
  [{ kind: "refused", message: "Not today" }, "Not today"],
  [{ kind: "cannotRemove", reason: "owner" }, "workspaces.removeMembers.cannotRemoveOwner"],
  [{ kind: "cannotRemove", reason: "self" }, "workspaces.removeMembers.cannotRemoveSelf"],
  [{ kind: "failed" }, `workspaces.removeMember.failed|{"name":"${isolated("Liam")}"}`],
]) {
  test(`a ${error.kind}${error.reason ? ` ${error.reason}` : ""} failure shows its line`, async (t) => {
    const { mount } = await loadDialog(t);

    await mount({
      kind: "failed",
      subjects: [LIAM],
      owners: [],
      transferTo: null,
      defaultOwnerId: "u-self",
      error,
    });

    assert.equal(globalThis.__actionDialogProps.error, line);
    assert.deepEqual(globalThis.__previewCalls, []);
  });
}
