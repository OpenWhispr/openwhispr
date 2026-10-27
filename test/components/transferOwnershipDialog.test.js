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

const MEMBERS = [
  { user_id: "u-self", name: "Olivia Owner", email: "olivia@example.com", role: "owner" },
  { user_id: "u-admin", name: "Adam Admin", email: "adam@example.com", role: "admin" },
  { user_id: "u-member", name: "Mia Member", email: "mia@example.com", role: "member" },
];
const WORKSPACE = { id: "w1", name: "Acme", role: "owner" };

function textOf(node) {
  if (node.nodeType === 3) return node.nodeValue;
  return [...node.childNodes].map(textOf).join("");
}

async function loadDialog(t) {
  t.after(() => {
    for (const key of [
      "__actionDialogProps",
      "__store",
      "__toasts",
      "__transferCalls",
      "__transferImpl",
      "__pickerDisabled",
      "__menuContentProps",
    ]) {
      delete globalThis[key];
    }
  });
  installBrowserGlobals(t);
  globalThis.__toasts = [];
  globalThis.__transferCalls = [];
  globalThis.__transferImpl = async () => {};
  globalThis.__store = {
    members: MEMBERS,
    activeWorkspaceId: "w1",
    membersWorkspaceId: "w1",
    refreshMembers: async () => {},
  };
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-transfer-dialog-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `
        export function useTranslation() {
          return { t: (key, params) => (params ? key + "|" + JSON.stringify(params) : key) };
        }
      `,
      "/stores/workspaceStore": `
        export const useWorkspaceStore = (selector) => selector(globalThis.__store);
      `,
      "/hooks/useAuth": `export const useAuth = () => ({ user: { id: "u-self" } });`,
      "/ui/useToast": `
        export const useToast = () => ({ toast: (toast) => globalThis.__toasts.push(toast) });
      `,
      "/services/workspaceActions": `
        export const transferOwnership = (workspaceId, userId) => {
          globalThis.__transferCalls.push([workspaceId, userId]);
          return globalThis.__transferImpl();
        };
      `,
      "/ui/dropdown-menu": `
        import React from "react";
        const passThrough = ({ children }) => React.createElement(React.Fragment, null, children);
        export const DropdownMenu = passThrough;
        export const DropdownMenuContent = (props) => {
          globalThis.__menuContentProps = props;
          return passThrough(props);
        };
        export const DropdownMenuTrigger = ({ children, disabled }) => {
          globalThis.__pickerDisabled = Boolean(disabled);
          return React.createElement("button", { "data-picker": "", disabled: disabled || undefined }, children);
        };
        export const DropdownMenuItem = ({ children }) =>
          React.createElement("div", { role: "menuitem" }, children);
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
            props.error ? React.createElement("p", { role: "alert" }, props.error) : null,
            React.createElement(
              "button",
              { id: "primary", disabled: props.busy || props.primary.disabled || undefined },
              props.primary.label
            ),
            props.cancelLabel && !props.busy
              ? React.createElement("button", { id: "cancel" }, props.cancelLabel)
              : null
          );
        }
      `,
    },
  });
  const { TransferOwnershipDialog } = await vite.ssrLoadModule(
    "/components/workspace/TransferOwnershipDialog.tsx"
  );
  const events = [];
  const transferred = [];
  const props = (state, overrides = {}) => ({
    workspace: WORKSPACE,
    state,
    dispatch: (event) => events.push(event.type),
    onTransferred: (member) => transferred.push(member.user_id),
    ...overrides,
  });
  const render = (state, overrides) =>
    renderToStaticMarkup(React.createElement(TransferOwnershipDialog, props(state, overrides)));
  // Mounted, so the roster read on opening runs; returns the text once it has settled.
  const mount = async (state) => {
    const container = installHostDom(t);
    const root = createRoot(container);
    await React.act(async () =>
      root.render(React.createElement(TransferOwnershipDialog, props(state)))
    );
    const text = textOf(container);
    await React.act(async () => root.unmount());
    return text;
  };
  return { render, mount, props, events, transferred, TransferOwnershipDialog };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("closed renders nothing", async (t) => {
  const { render } = await loadDialog(t);

  assert.equal(render({ kind: "closed" }), "");
});

test("choosing without a pick shows the choose copy and a disabled transfer", async (t) => {
  const { mount } = await loadDialog(t);

  const markup = await mount({ kind: "choosing", candidateId: null });

  assert.match(markup, /workspaces\.transfer\.title/);
  assert.match(markup, /workspaces\.transfer\.body/);
  assert.match(markup, /workspaces\.transfer\.placeholder/);
  // Owner and self are not offered; the role label is the translated role.
  assert.match(markup, /Adam Admin/);
  assert.match(markup, /settingsPage\.workspace\.role\.admin/);
  assert.doesNotMatch(markup, /Olivia Owner/);
  assert.equal(globalThis.__actionDialogProps.primary.disabled, true);
  assert.equal(globalThis.__actionDialogProps.primary.tone, "primary");
});

test("a preselected member shows the confirm copy and enables transfer", async (t) => {
  const { mount } = await loadDialog(t);

  const markup = await mount({ kind: "choosing", candidateId: "u-admin" });

  assert.match(markup, /workspaces\.transfer\.confirmTitle\|\{"name":"Adam Admin"/);
  assert.match(markup, /workspaces\.transfer\.confirmBody/);
  assert.match(markup, /Acme/);
  assert.match(markup, /workspaces\.transfer\.submit/);
  assert.notEqual(globalThis.__actionDialogProps.primary.disabled, true);
});

test("no candidates disables transfer", async (t) => {
  const { mount } = await loadDialog(t);
  globalThis.__store.members = [MEMBERS[0]];

  const markup = await mount({ kind: "choosing", candidateId: null });

  assert.match(markup, /workspaces\.transfer\.noCandidates/);
  assert.equal(globalThis.__actionDialogProps.primary.disabled, true);
  assert.equal(globalThis.__pickerDisabled, true);
});

test("a roster already in the store is read again, so a member who left isn't offered", async (t) => {
  const { mount } = await loadDialog(t);
  let reads = 0;
  globalThis.__store.refreshMembers = async () => {
    reads++;
    globalThis.__store.members = MEMBERS.filter((m) => m.user_id !== "u-member");
  };

  const text = await mount({ kind: "choosing", candidateId: null });

  assert.equal(reads, 1);
  assert.match(text, /Adam Admin/);
  assert.doesNotMatch(text, /Mia Member/);
});

test("a roster the store holds for another workspace offers nobody", async (t) => {
  const { mount } = await loadDialog(t);
  globalThis.__store.membersWorkspaceId = "w-previous";

  const text = await mount({ kind: "choosing", candidateId: null });

  assert.match(text, /workspaces\.transfer\.noCandidates/);
  assert.doesNotMatch(text, /Adam Admin/);
});

// Picking enables Transfer ownership, which sits below the picker: a list opened downward put the
// second click of a double-click on it, transferring before the confirmation was read.
test("the candidate list opens upward and never flips over the buttons", async (t) => {
  const { mount } = await loadDialog(t);

  await mount({ kind: "choosing", candidateId: null });

  assert.equal(globalThis.__menuContentProps.side, "top");
  assert.equal(globalThis.__menuContentProps.avoidCollisions, false);
});

test("transferring is busy with its own copy", async (t) => {
  const { render } = await loadDialog(t);

  const markup = render({ kind: "transferring", candidateId: "u-admin" });

  assert.match(markup, /workspaces\.transfer\.transferringTitle/);
  assert.match(markup, /workspaces\.transfer\.transferringBody/);
  assert.match(markup, /workspaces\.transfer\.transferring</);
  assert.doesNotMatch(markup, /common\.cancel/);
  assert.equal(globalThis.__actionDialogProps.busy, true);
});

test("failed shows the error with Try again and Cancel", async (t) => {
  const { render } = await loadDialog(t);

  const markup = render({ kind: "failed", candidateId: "u-admin", reason: null });

  assert.match(markup, /role="alert"[^>]*>workspaces\.transfer\.failed/);
  assert.match(markup, /workspaces\.exit\.tryAgain/);
  assert.match(markup, /common\.cancel/);
});

test("success toasts and calls onTransferred", async (t) => {
  const { render, events, transferred } = await loadDialog(t);

  render({ kind: "choosing", candidateId: "u-admin" });
  globalThis.__actionDialogProps.primary.onClick();
  await tick();

  assert.deepEqual(globalThis.__transferCalls, [["w1", "u-admin"]]);
  assert.deepEqual(events, ["confirm", "dismiss"]);
  assert.equal(globalThis.__toasts.length, 1);
  assert.match(globalThis.__toasts[0].title, /workspaces\.transfer\.done/);
  assert.match(globalThis.__toasts[0].title, /Adam Admin/);
  assert.deepEqual(transferred, ["u-admin"]);
});

test("a rejected transfer dispatches failed without a toast", async (t) => {
  const { render, events, transferred } = await loadDialog(t);
  globalThis.__transferImpl = async () => {
    throw new Error("offline");
  };

  render({ kind: "choosing", candidateId: "u-admin" });
  globalThis.__actionDialogProps.primary.onClick();
  await tick();

  assert.deepEqual(events, ["confirm", "failed"]);
  assert.deepEqual(globalThis.__toasts, []);
  assert.deepEqual(transferred, []);
});

test("a refusal replaces the you're-still-the-Owner copy", async (t) => {
  const { render } = await loadDialog(t);

  const markup = render({ kind: "failed", candidateId: "u-admin", reason: "No seats left" });

  assert.match(markup, /role="alert"[^>]*>No seats left</);
  assert.doesNotMatch(markup, /workspaces\.transfer\.failed/);
});

test("member load failure offers retry", async (t) => {
  const { props, TransferOwnershipDialog } = await loadDialog(t);
  const container = installHostDom(t);
  let calls = 0;
  globalThis.__store = {
    members: [],
    activeWorkspaceId: "w1",
    membersWorkspaceId: "w1",
    refreshMembers: async () => {
      calls++;
      throw new Error("offline");
    },
  };
  const root = createRoot(container);

  await React.act(async () =>
    root.render(
      React.createElement(TransferOwnershipDialog, props({ kind: "choosing", candidateId: null }))
    )
  );

  const text = textOf(container);
  assert.equal(calls, 1);
  assert.match(text, /settingsPage\.workspace\.members\.loadError/);
  assert.match(text, /common\.retry/);
  assert.equal(globalThis.__actionDialogProps.primary.disabled, true);
  await React.act(async () => root.unmount());
});

test("an empty roster loads before the picker is offered", async (t) => {
  const { props, TransferOwnershipDialog } = await loadDialog(t);
  const container = installHostDom(t);
  let release;
  globalThis.__store = {
    members: [],
    activeWorkspaceId: "w1",
    membersWorkspaceId: "w1",
    refreshMembers: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  };
  const root = createRoot(container);

  await React.act(async () =>
    root.render(
      React.createElement(TransferOwnershipDialog, props({ kind: "choosing", candidateId: null }))
    )
  );

  assert.doesNotMatch(textOf(container), /workspaces\.transfer\.noCandidates/);
  assert.equal(globalThis.__actionDialogProps.primary.disabled, true);
  await React.act(async () => release());
  await React.act(async () => root.unmount());
});
