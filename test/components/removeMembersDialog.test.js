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

function findById(node, id) {
  if (node.attributes?.id === id) return node;
  for (const child of node.childNodes ?? []) {
    const found = findById(child, id);
    if (found) return found;
  }
  return null;
}

function findAutoDirection(node) {
  const here = node.attributes?.dir === "auto" ? [node] : [];
  return [...here, ...(node.childNodes ?? []).flatMap(findAutoDirection)];
}

function textOf(node) {
  if (node.nodeType === 3) return node.nodeValue;
  return [...node.childNodes].map(textOf).join("");
}

const GLOBALS = [
  "__actionDialogProps",
  "__menuContentProps",
  "__menuItems",
  "__menuItemTextValues",
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
      "/i18n": "export default { t: (key) => key };",
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
          globalThis.__menuItemTextValues = [];
          return React.createElement("div", { role: "menu" }, props.children);
        };
        export const DropdownMenuTrigger = (props) => {
          globalThis.__triggerProps = props;
          return React.createElement("button", null, "‹", props.children, "›");
        };
        export const DropdownMenuItem = ({ children, onSelect, textValue }) => {
          globalThis.__menuItems.push(onSelect);
          globalThis.__menuItemTextValues.push(textValue);
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
  const mount = async (initial, extraProps = {}) => {
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
        ...extraProps,
      });
    }
    const container = installHostDom(t);
    const root = createRoot(container);
    roots.push(root);
    await React.act(async () => root.render(React.createElement(Harness)));
    return {
      events,
      removed,
      container,
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
  assert.match(text, /workspaces\.removeMembers\.body/);
  assert.match(text, /workspaces\.removeMembers\.confirm\|\{"count":2\}/);
  assert.equal(globalThis.__triggerProps, undefined);
  const props = globalThis.__actionDialogProps;
  assert.equal(props.icon, "trash");
  assert.equal(props.primary.tone, "destructive");
  assert.notEqual(props.primary.disabled, true);
  assert.equal(props.cancelLabel, "common.cancel");
});

test("a selection that also held the owner says the owner stays", async (t) => {
  const { mount, opened } = await loadDialog(t);
  globalThis.__previewImpl = async () => preview([owns("u-liam", 0, 0)]);

  const plain = await mount(opened([LIAM]));
  assert.doesNotMatch(plain.text(), /cannotRemoveOwner/);

  const withOwner = await mount(opened([LIAM]), { ownerKept: true });
  assert.match(withOwner.text(), /workspaces\.removeMembers\.cannotRemoveOwner/);
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
  // The reassign body and the note on who owns what; the picker follows in its own card.
  assert.match(text, /workspaces\.removeMembers\.reassignBody/);
  assert.match(text, /workspaces\.removeMembers\.transferConfirm/);
  // Named by the visible label and the chosen owner together: "Transfer to Ronnie (you)".
  const trigger = globalThis.__triggerProps;
  assert.equal(trigger["aria-label"], undefined);
  const labelledBy = trigger["aria-labelledby"].split(" ");
  assert.equal(labelledBy.length, 2);
  assert.deepEqual(
    labelledBy.map((id) => textOf(findById(view.container, id))),
    [
      "workspaces.removeMembers.transferLabel",
      `workspaces.removeMembers.you|{"name":"${isolated("Ronnie")}"}`,
    ]
  );
  assert.equal(pickerText(text), `workspaces.removeMembers.you|{"name":"${isolated("Ronnie")}"}`);
  // You first, then everyone not being removed by name, each with their email.
  assert.deepEqual(menuItems(text), [
    `workspaces.removeMembers.you|{"name":"${isolated("Ronnie")}"}self@example.com`,
    `${isolated("Alex")}alex@example.com`,
    `${isolated("Bea")}owner@example.com`,
    `${isolated("Zoe")}zoe@example.com`,
  ]);
  assert.equal(globalThis.__menuContentProps.side, "top");
  assert.equal(globalThis.__menuContentProps.avoidCollisions, false);
  assert.match(globalThis.__menuContentProps.className, /max-h-\[min\(16rem,/);
  assert.notEqual(globalThis.__actionDialogProps.primary.disabled, true);
});

test("the new owner's name sits by its avatar in RTL", async (t) => {
  const { mount, opened } = await loadDialog(t);
  globalThis.__previewImpl = async () => preview([owns("u-liam")]);

  const view = await mount(opened([LIAM]));

  // dir="auto" resolves a Latin name to LTR, which starts it on the far side of an RTL row.
  const [labelId, valueId] = globalThis.__triggerProps["aria-labelledby"].split(" ");
  const value = findById(view.container, valueId);
  assert.ok(findById(view.container, labelId));
  assert.equal(value.attributes.dir, undefined);
  for (const name of ["flex-1", "truncate", "text-start"]) {
    assert.ok(value.attributes.class.split(" ").includes(name), name);
  }
  assert.deepEqual(findAutoDirection(view.container), []);

  // The picked name is still its own run, now that nothing around it resolves the direction.
  await view.act(() => globalThis.__menuItems[3]());
  assert.equal(pickerText(view.text()), isolated("Zoe"));
  assert.equal(textOf(findById(view.container, valueId)), isolated("Zoe"));
});

test("typing in the picker matches the plain name, not the isolated label", async (t) => {
  const { mount, opened } = await loadDialog(t);
  globalThis.__previewImpl = async () => preview([owns("u-liam")]);

  await mount(opened([LIAM]));

  // Radix matches an item's text from its first character, and the label starts with an isolate.
  assert.deepEqual(globalThis.__menuItemTextValues, ["Ronnie", "Alex", "Bea", "Zoe"]);
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
  assert.match(view.text(), /workspaces\.removeMembers\.body/);
});

test("a failed preview offers the plain confirm", async (t) => {
  const { mount, opened } = await loadDialog(t);
  globalThis.__previewImpl = async () => {
    throw new Error("offline");
  };

  const view = await mount(opened([LIAM, ALEX]));

  assert.match(view.text(), /workspaces\.removeMembers\.confirm\|\{"count":2\}/);
});

test("a malformed preview offers the plain confirm", async (t) => {
  const { mount, opened } = await loadDialog(t);

  for (const reply of [{}, { members: {} }, { members: "u-liam" }, undefined]) {
    globalThis.__previewImpl = async () => reply;
    const view = await mount(opened([LIAM, ALEX]));

    assert.match(
      view.text(),
      /workspaces\.removeMembers\.confirm\|\{"count":2\}/,
      JSON.stringify(reply)
    );
    assert.equal(view.events.at(-1).type, "previewFailed");
  }
});

test("notes the new owner can't reach stay put, and the toast says so", async (t) => {
  const { mount, opened } = await loadDialog(t);
  globalThis.__previewImpl = async () => preview([owns("u-liam", 3), owns("u-alex", 2)]);
  globalThis.__removeImpl = async () => ({
    removed: ["u-liam", "u-alex"],
    already_removed: [],
    transferred: { to: "u-zoe", notes: 1, spaces: 0 },
  });
  const view = await mount(opened([LIAM, ALEX]));

  await view.act(() => globalThis.__menuItems[2]());
  await view.clickPrimary();

  assert.deepEqual(globalThis.__toasts, [
    {
      title: 'workspaces.removeMembers.done|{"count":2}',
      description: `workspaces.removeMembers.transferPartial|{"count":4,"name":"${isolated("Zoe")}"}`,
    },
  ]);
});

test("nothing moved reads the same, never as a move", async (t) => {
  const { mount, opened } = await loadDialog(t);
  globalThis.__previewImpl = async () => preview([owns("u-liam", 3)]);
  globalThis.__removeImpl = async () => ({
    removed: ["u-liam"],
    already_removed: [],
    transferred: { to: "u-zoe", notes: 0, spaces: 0 },
  });
  const view = await mount(opened([LIAM]));

  await view.act(() => globalThis.__menuItems[2]());
  await view.clickPrimary();

  assert.doesNotMatch(globalThis.__toasts[0].title, /transferDone/);
  assert.match(globalThis.__toasts[0].description, /transferPartial\|\{"count":3/);
});

test("someone removed since the preview doesn't count as notes left behind", async (t) => {
  const { mount, opened } = await loadDialog(t);
  globalThis.__previewImpl = async () => preview([owns("u-liam", 3), owns("u-alex", 2)]);
  globalThis.__removeImpl = async () => ({
    removed: ["u-liam"],
    already_removed: ["u-alex"],
    transferred: { to: "u-zoe", notes: 3, spaces: 0 },
  });
  const view = await mount(opened([LIAM, ALEX]));

  await view.act(() => globalThis.__menuItems[2]());
  await view.clickPrimary();

  assert.deepEqual(globalThis.__toasts, [
    { title: `workspaces.removeMembers.transferDone|{"name":"${isolated("Zoe")}","count":2}` },
  ]);
});

test("people an identity provider assigns are named, so they can be unticked", async (t) => {
  const { mount, opened, CloudApiError } = await loadDialog(t);
  globalThis.__previewImpl = async () => {
    throw directoryManaged(CloudApiError, { user_ids: ["u-liam", "u-alex"] });
  };

  const view = await mount(opened([LIAM, ALEX, ZOE]));

  assert.match(view.text(), /directoryManagedOthers/);
  assert.match(view.text(), new RegExp(isolated("Liam")));
  assert.match(view.text(), new RegExp(isolated("Alex")));
  assert.doesNotMatch(view.text(), new RegExp(isolated("Zoe")));
});

test("a member as new owner warns that some notes may stay; an admin doesn't", async (t) => {
  const { mount, opened } = await loadDialog(t);
  globalThis.__previewImpl = async () => preview([owns("u-liam")]);
  const view = await mount(opened([LIAM]));

  // You, an admin, by default: nothing is withheld, so there is no warning.
  assert.doesNotMatch(view.text(), /workspaces\.removeMembers\.transferBodyLimited/);

  // Candidates: you, Bea, Alex, Zoe.
  await view.act(() => globalThis.__menuItems[3]());

  assert.match(
    view.text(),
    new RegExp(
      `workspaces\\.removeMembers\\.transferBodyLimited\\|\\{"name":"${isolated("Zoe")}"\\}`
    )
  );
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
  assert.equal(pickerText(view.text()), isolated("Zoe"));
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
  // The same action retries, so the button keeps its label.
  assert.equal(globalThis.__actionDialogProps.primary.label, "workspaces.removeMembers.transferConfirm");
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
  // A plain failure replaces the question: nothing changed, so the dialog says so and offers Try again.
  assert.equal(globalThis.__actionDialogProps.title, 'workspaces.removeMembers.failedTitle|{"count":2}');
  assert.equal(globalThis.__actionDialogProps.error, null);
  assert.equal(globalThis.__actionDialogProps.primary.label, "workspaces.exit.tryAgain");

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
  assert.equal(globalThis.__actionDialogProps.primary.label, "workspaces.removeMembers.transferConfirm");
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
  [
    { kind: "directoryManaged", userIds: ["u-liam"] },
    `workspaces.removeMembers.directoryManagedOne|{"name":"${isolated("Liam")}"}`,
  ],
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

for (const kind of ["failed", "rateLimited"]) {
  test(`a ${kind} failure replaces the question with the failure state`, async (t) => {
    const { mount } = await loadDialog(t);

    await mount({
      kind: "failed",
      subjects: [LIAM],
      owners: [],
      transferTo: null,
      defaultOwnerId: "u-self",
      error: { kind },
    });

    const props = globalThis.__actionDialogProps;
    assert.equal(props.title, `workspaces.removeMember.failedTitle|{"name":"${isolated("Liam")}"}`);
    assert.equal(props.body, "workspaces.removeMembers.failedBody");
    assert.equal(props.error, null);
    assert.equal(props.primary.label, "workspaces.exit.tryAgain");
  });
}

const directoryManaged = (CloudApiError, details) =>
  new CloudApiError(
    "Remove them in your identity provider instead",
    409,
    "directory_managed",
    details
  );

test("a member the identity provider assigns is named and Remove stays disabled", async (t) => {
  const { mount, opened, CloudApiError } = await loadDialog(t);
  globalThis.__previewImpl = async () => {
    throw directoryManaged(CloudApiError, { user_ids: ["u-alex"] });
  };

  const view = await mount(opened([LIAM, ALEX]));

  assert.equal(view.events.at(-1).type, "previewRefused");
  const props = globalThis.__actionDialogProps;
  // Alex, not whoever was selected first.
  assert.equal(
    props.error,
    `workspaces.removeMembers.directoryManagedOneOthers|{"name":"${isolated("Alex")}"}`
  );
  assert.equal(props.primary.label, 'workspaces.removeMembers.confirm|{"count":2}');
  assert.equal(props.primary.disabled, true);
  assert.notEqual(props.primary.pending, true);
  assert.equal(props.cancelLabel, "common.cancel");
  assert.notEqual(props.busy, true);
  assert.deepEqual(globalThis.__removeCalls, []);
});

test("a one-person selection names them when the list can't be read", async (t) => {
  const { mount, opened, CloudApiError } = await loadDialog(t);
  globalThis.__previewImpl = async () => {
    throw directoryManaged(CloudApiError, {});
  };

  await mount(opened([LIAM]));

  const props = globalThis.__actionDialogProps;
  assert.equal(
    props.error,
    `workspaces.removeMembers.directoryManagedOne|{"name":"${isolated("Liam")}"}`
  );
  assert.equal(props.primary.label, "workspaces.removeMember.confirm");
  assert.equal(props.primary.disabled, true);
});

test("a managed id outside the selection reads like an unreadable list", async (t) => {
  // Nobody here to name, and no one to tell the user to untick.
  const { mount, opened, CloudApiError } = await loadDialog(t);
  globalThis.__previewImpl = async () => {
    throw directoryManaged(CloudApiError, { user_ids: ["u-someone-else"] });
  };

  await mount(opened([LIAM, ALEX]));

  assert.equal(
    globalThis.__actionDialogProps.error,
    'workspaces.removeMembers.directoryManaged|{"count":2}'
  );
});

test("one person selected keeps the plain line, without the untick", async (t) => {
  const { mount, opened, CloudApiError } = await loadDialog(t);
  globalThis.__previewImpl = async () => {
    throw directoryManaged(CloudApiError, { user_ids: ["u-liam"] });
  };

  await mount(opened([LIAM]));

  assert.equal(
    globalThis.__actionDialogProps.error,
    `workspaces.removeMembers.directoryManagedOne|{"name":"${isolated("Liam")}"}`
  );
});

test("several selected and one managed names them and says the others can go", async (t) => {
  const { mount, opened, CloudApiError } = await loadDialog(t);
  globalThis.__previewImpl = async () => {
    throw directoryManaged(CloudApiError, { user_ids: ["u-zoe"] });
  };

  await mount(opened([LIAM, ALEX, ZOE]));

  const props = globalThis.__actionDialogProps;
  assert.equal(
    props.error,
    `workspaces.removeMembers.directoryManagedOneOthers|{"name":"${isolated("Zoe")}"}`
  );
  assert.equal(props.primary.disabled, true);
  assert.equal(props.cancelLabel, "common.cancel");
});

test("several selected and some managed counts them and says the others can go", async (t) => {
  const { mount, opened, CloudApiError } = await loadDialog(t);
  globalThis.__previewImpl = async () => {
    // One id from outside the selection: the count is the people the user can see.
    throw directoryManaged(CloudApiError, { user_ids: ["u-liam", "u-alex", "u-someone-else"] });
  };

  await mount(opened([LIAM, ALEX, ZOE]));

  const props = globalThis.__actionDialogProps;
  assert.equal(props.error, 'workspaces.removeMembers.directoryManagedOthers|{"count":2}');
  assert.equal(props.primary.disabled, true);
  assert.equal(props.cancelLabel, "common.cancel");
});

test("everyone selected being managed offers no untick", async (t) => {
  const { mount, opened, CloudApiError } = await loadDialog(t);
  globalThis.__previewImpl = async () => {
    throw directoryManaged(CloudApiError, { user_ids: ["u-liam", "u-alex"] });
  };

  await mount(opened([LIAM, ALEX]));

  assert.equal(
    globalThis.__actionDialogProps.error,
    'workspaces.removeMembers.directoryManaged|{"count":2}'
  );
});

test("an empty list on several people counts them all", async (t) => {
  const { mount, opened, CloudApiError } = await loadDialog(t);
  globalThis.__previewImpl = async () => {
    throw directoryManaged(CloudApiError, { user_ids: [] });
  };

  await mount(opened([LIAM, ALEX, ZOE]));

  assert.equal(
    globalThis.__actionDialogProps.error,
    'workspaces.removeMembers.directoryManaged|{"count":3}'
  );
});

test("several are counted", async (t) => {
  const { mount, opened, CloudApiError } = await loadDialog(t);
  globalThis.__previewImpl = async () => {
    throw directoryManaged(CloudApiError, { user_ids: ["u-liam", "u-alex"] });
  };

  await mount(opened([LIAM, ALEX, ZOE]));

  const props = globalThis.__actionDialogProps;
  assert.equal(props.error, 'workspaces.removeMembers.directoryManagedOthers|{"count":2}');
  assert.equal(props.primary.label, 'workspaces.removeMembers.confirm|{"count":3}');
  assert.equal(props.primary.disabled, true);
});

test("a malformed list on several people counts them all", async (t) => {
  const { mount, opened, CloudApiError } = await loadDialog(t);
  globalThis.__previewImpl = async () => {
    throw directoryManaged(CloudApiError, { user_ids: "nope" });
  };

  await mount(opened([LIAM, ALEX, ZOE]));

  assert.equal(
    globalThis.__actionDialogProps.error,
    'workspaces.removeMembers.directoryManaged|{"count":3}'
  );
});

test("the run's answer names the member and Remove stays disabled", async (t) => {
  const { mount, opened, CloudApiError } = await loadDialog(t);
  globalThis.__removeImpl = async () => {
    throw directoryManaged(CloudApiError, { user_ids: ["u-alex"] });
  };
  const view = await mount(opened([LIAM, ALEX]));

  await view.clickPrimary();

  assert.equal(globalThis.__removeCalls.length, 1);
  const props = globalThis.__actionDialogProps;
  assert.equal(
    props.error,
    `workspaces.removeMembers.directoryManagedOneOthers|{"name":"${isolated("Alex")}"}`
  );
  assert.equal(props.primary.label, 'workspaces.removeMembers.confirm|{"count":2}');
  assert.equal(props.primary.disabled, true);
  assert.equal(props.cancelLabel, "common.cancel");
  assert.notEqual(props.busy, true);
  assert.deepEqual(view.removed, []);
  assert.deepEqual(globalThis.__toasts, []);
});

test("the picker stays open to changes after other failures", async (t) => {
  const { mount, opened, CloudApiError } = await loadDialog(t);
  globalThis.__previewImpl = async () => preview([owns("u-liam")]);
  globalThis.__removeImpl = async () => {
    throw new CloudApiError("Server error", 500);
  };
  const view = await mount(opened([LIAM]));
  assert.equal(globalThis.__triggerProps.disabled, false);

  await view.clickPrimary();

  assert.equal(globalThis.__actionDialogProps.primary.label, "workspaces.removeMembers.transferConfirm");
  assert.equal(globalThis.__triggerProps.disabled, false);
});

test("a run refused while transferring keeps the transfer label, disabled", async (t) => {
  const { mount, opened, CloudApiError } = await loadDialog(t);
  globalThis.__previewImpl = async () => preview([owns("u-liam")]);
  globalThis.__removeImpl = async () => {
    throw directoryManaged(CloudApiError, { user_ids: ["u-liam", "u-alex"] });
  };
  const view = await mount(opened([LIAM, ALEX]));

  await view.clickPrimary();

  const props = globalThis.__actionDialogProps;
  assert.equal(props.error, 'workspaces.removeMembers.directoryManaged|{"count":2}');
  assert.equal(props.primary.label, "workspaces.removeMembers.transferConfirm");
  assert.equal(props.primary.disabled, true);
  // Choosing someone else can't help, so the picker doesn't offer to.
  assert.equal(globalThis.__triggerProps.disabled, true);
});

test("other preview failures still offer the plain confirm", async (t) => {
  const { mount, opened, CloudApiError } = await loadDialog(t);

  for (const failure of [
    new CloudApiError("Server error", 500),
    new CloudApiError("Forbidden", 403),
    new CloudApiError("SSO", 403, "SSO_REQUIRED"),
    new CloudApiError("Transfer required", 409, "transfer_required", { members: [] }),
    new CloudApiError("Slow down", 429, "rate_limited"),
    new Error("offline"),
  ]) {
    globalThis.__previewImpl = async () => {
      throw failure;
    };
    const view = await mount(opened([LIAM, ALEX]));

    assert.equal(view.events.at(-1).type, "previewFailed", failure.message);
    const props = globalThis.__actionDialogProps;
    assert.equal(props.error, null, failure.message);
    assert.equal(props.primary.label, 'workspaces.removeMembers.confirm|{"count":2}');
    assert.notEqual(props.primary.disabled, true, failure.message);
  }
});
