const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createElement } = React;
const { createRoot } = require("react-dom/client");
const { renderToStaticMarkup } = require("react-dom/server");
const {
  createRendererServer,
  installBrowserGlobals,
  installHappyDom,
} = require("../lib/rendererTestHarness");

const ROLE_CAPS = {
  owner: { manage_settings: true, delete_workspace: true, transfer_ownership: true, leave: false },
  admin: { manage_settings: true, delete_workspace: false, transfer_ownership: false, leave: true },
  member: {
    manage_settings: false,
    delete_workspace: false,
    transfer_ownership: false,
    leave: true,
  },
};

const WORKSPACE = { id: "w1", name: "Acme Research", seats: 5 };

// `realCapabilities` reads the workspace's own capabilities, as the app does. `dom` is for a
// test that installed happy-dom itself, to click.
async function loadSection(t, { realCapabilities = false, dom = false } = {}) {
  t.after(() => {
    delete globalThis.__caps;
    delete globalThis.__settingsWorkspace;
    delete globalThis.__exitDialogProps;
  });
  if (!dom) installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-workspace-general-section-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": "export const useTranslation = () => ({ t: (key) => key });",
      "/useSettingsWorkspace": `
        export const useSettingsWorkspace = () => globalThis.__settingsWorkspace;
      `,
      // The frame's loading, error and empty states are covered with the frame itself.
      "/SettingsWorkspaceFrame": `
        export default function Frame({ state, children }) {
          return state.workspace ? children(state.workspace) : null;
        }
      `,
      ...(realCapabilities
        ? {}
        : {
            "/lib/capabilities": `
              export const workspaceCan = (workspace, capability) =>
                globalThis.__caps?.[capability] === true;
            `,
          }),
      "/services/workspaceActions": `
        export const leaveWorkspace = async () => {};
        export const deleteWorkspace = async () => {};
        export const transferOwnership = async () => {};
      `,
      "/services/WorkspacesService": "export const WorkspacesService = {};",
      "/stores/workspaceStore": `
        export const useWorkspaceStore = (selector) =>
          selector({
            refresh: async () => {},
            workspaces: globalThis.__settingsWorkspace?.workspaces ?? [],
          });
      `,
      "/hooks/useAuth": "export const useAuth = () => ({ user: { id: 'u-self', name: 'Ada' } });",
      "/ui/useToast": "export const useToast = () => ({ toast: () => {} });",
      "/EnterpriseConsoleRow": "export default function Mock() { return null; }",
      "/WorkspaceExitDialog": `
        import React from "react";
        export function WorkspaceExitDialog(props) {
          globalThis.__exitDialogProps = props;
          return React.createElement("div", { "data-exit-dialog": "" });
        }
      `,
      "/TransferOwnershipDialog": `
        import React from "react";
        export function TransferOwnershipDialog() {
          return React.createElement("div", { "data-transfer-dialog": "" });
        }
      `,
    },
  });
  return vite.ssrLoadModule("/components/settings/WorkspaceGeneralSection.tsx");
}

function render(module, { role, name = WORKSPACE.name, caps = ROLE_CAPS[role], extra = {} }) {
  const workspace = { ...WORKSPACE, name, role, ...extra };
  globalThis.__caps = caps;
  globalThis.__settingsWorkspace = {
    status: "ready",
    workspace,
    workspaces: [workspace],
    retry: () => {},
  };
  return renderToStaticMarkup(createElement(module.default, { onNavigateToSection: () => {} }));
}

const nameInput = (markup) => {
  const match = markup.match(
    /<input[^>]*aria-label="settingsPage\.workspace\.general\.nameLabel"[^>]*>/
  );
  assert.ok(match, "name input");
  return match[0];
};

const ROW = {
  owner: "settingsPage.workspace.general.ownerTitle",
  delete: "settingsPage.workspace.general.dangerTitle",
  leave: "settingsPage.workspace.general.leaveTitle",
};

test("owner sees transfer and delete, no leave", async (t) => {
  const module = await loadSection(t);
  const markup = render(module, { role: "owner" });

  assert.match(markup, /settingsPage\.workspace\.general\.subtitleManage/);
  assert.ok(markup.includes(ROW.owner));
  assert.ok(markup.includes("workspaces.transfer.submit"));
  assert.ok(markup.includes(ROW.delete));
  assert.ok(markup.includes("settingsPage.workspace.general.dangerDescription"));
  assert.ok(!markup.includes(ROW.leave));
});

test("admin sees an editable name and leave, no delete or transfer", async (t) => {
  const module = await loadSection(t);
  const markup = render(module, { role: "admin" });

  assert.doesNotMatch(nameInput(markup), /disabled=""/);
  assert.match(markup, /common\.save/);
  assert.ok(markup.includes(ROW.leave));
  assert.ok(markup.includes("settingsPage.workspace.general.leaveDescription"));
  assert.ok(!markup.includes(ROW.delete));
  assert.ok(!markup.includes(ROW.owner));
});

test("member sees a read-only name and leave", async (t) => {
  const module = await loadSection(t);
  const markup = render(module, { role: "member" });

  assert.match(markup, /settingsPage\.workspace\.general\.subtitleView/);
  assert.match(nameInput(markup), /disabled=""/);
  assert.doesNotMatch(markup, /common\.save/);
  assert.ok(markup.includes(ROW.leave));
  assert.ok(!markup.includes(ROW.delete));
  assert.ok(!markup.includes(ROW.owner));
});

test("long existing name shows in full with Save disabled", async (t) => {
  const module = await loadSection(t);
  const longName = "A".repeat(36) + " " + "B".repeat(35);
  assert.equal(longName.length, 72);
  const markup = render(module, { role: "owner", name: longName });

  const input = nameInput(markup);
  assert.ok(input.includes(`value="${longName}"`), "the name is not truncated");
  assert.match(input, /maxLength="65"|maxlength="65"/i);
  assert.match(markup, /<button[^>]*disabled=""[^>]*>common\.save<\/button>/);
  assert.match(markup, /settingsPage\.workspace\.general\.nameHint/);
});

test("Save needs a changed, non-empty name of at most 65 characters", async (t) => {
  const { canSaveWorkspaceName, WORKSPACE_NAME_MAX } = await loadSection(t);
  assert.equal(WORKSPACE_NAME_MAX, 65);
  const saved = "Acme";
  assert.equal(canSaveWorkspaceName("Acme", saved), false);
  assert.equal(canSaveWorkspaceName("  Acme  ", saved), false);
  assert.equal(canSaveWorkspaceName("   ", saved), false);
  assert.equal(canSaveWorkspaceName("Acme Labs", saved), true);
  assert.equal(canSaveWorkspaceName("x".repeat(65), saved), true);
  assert.equal(canSaveWorkspaceName("x".repeat(66), saved), false);
  // An existing 72-character name stays unsaveable until it is shortened.
  const long = "y".repeat(72);
  assert.equal(canSaveWorkspaceName(long.slice(0, 70), long), false);
  assert.equal(canSaveWorkspaceName(long.slice(0, 65), long), true);
});

test("rows follow server capabilities, not the role", async (t) => {
  const module = await loadSection(t);
  const markup = render(module, {
    role: "member",
    caps: { ...ROLE_CAPS.member, delete_workspace: true, leave: false },
  });

  assert.ok(markup.includes(ROW.delete));
  assert.ok(!markup.includes(ROW.leave));
  assert.ok(!markup.includes(ROW.owner));

  // An owner whose session the server holds back (e.g. Require SSO) gets no owner rows.
  const blockedOwner = render(module, {
    role: "owner",
    caps: { manage_settings: false, delete_workspace: false, transfer_ownership: false },
  });
  assert.ok(!blockedOwner.includes(ROW.delete));
  assert.ok(!blockedOwner.includes(ROW.owner));
  assert.match(nameInput(blockedOwner), /disabled=""/);
});

test("delete is unavailable for the default workspace", async (t) => {
  const module = await loadSection(t, { realCapabilities: true });
  const capabilities = {
    manage_members: true,
    manage_teams: true,
    create_spaces: true,
    manage_settings: true,
    manage_billing: true,
    transfer_ownership: true,
    leave: false,
  };

  const own = render(module, {
    role: "owner",
    extra: {
      is_default: true,
      is_account_default: true,
      capabilities: { ...capabilities, delete_workspace: false },
    },
  });
  assert.ok(!own.includes(ROW.delete));
  assert.ok(own.includes(ROW.owner), "the rest of the owner's page stays");

  const another = render(module, {
    role: "owner",
    extra: {
      is_default: false,
      is_account_default: false,
      capabilities: { ...capabilities, delete_workspace: true },
    },
  });
  assert.ok(another.includes(ROW.delete));
});

test("the leave dialog keeps naming where private notes go while the leave runs", async (t) => {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  const happyWindow = await installHappyDom(t);
  const module = await loadSection(t, { dom: true });
  const lab = { id: "mine", name: "Ada's lab", role: "owner", is_default: true };
  const acme = { ...WORKSPACE, role: "member", is_default: false };
  globalThis.__caps = ROLE_CAPS.member;
  globalThis.__settingsWorkspace = {
    status: "ready",
    workspace: acme,
    workspaces: [acme, lab],
    retry: () => {},
  };
  const host = happyWindow.document.createElement("div");
  happyWindow.document.body.append(host);
  root = createRoot(host);
  const show = () =>
    React.act(async () =>
      root.render(createElement(module.default, { onNavigateToSection: () => {} }))
    );
  const dialog = () => globalThis.__exitDialogProps;

  await show();
  const leave = [...host.querySelectorAll("button")].find(
    (button) => button.textContent.trim() === "settingsPage.workspace.general.leave"
  );
  await React.act(async () => leave.click());
  assert.equal(dialog().state.kind, "confirmLeave");
  assert.equal(dialog().privateNotesWorkspace, "Ada's lab");

  // While it runs the store forgets Acme and lands on the default (another window switching
  // does the same): the sentence keeps the destination it was confirmed with.
  await React.act(async () => dialog().dispatch({ type: "confirm" }));
  globalThis.__settingsWorkspace = {
    status: "ready",
    workspace: lab,
    workspaces: [lab],
    retry: () => {},
  };
  await show();
  assert.equal(dialog().state.kind, "leaving");
  assert.equal(dialog().privateNotesWorkspace, "Ada's lab");

  // The outcome says where the user is now.
  await React.act(async () => dialog().dispatch({ type: "succeeded" }));
  assert.equal(dialog().state.kind, "left");
  assert.equal(dialog().currentWorkspace, "Ada's lab");
});

test("icon shows initials and no upload control", async (t) => {
  const module = await loadSection(t);
  const markup = render(module, { role: "owner" });

  assert.match(markup, /settingsPage\.workspace\.general\.iconLabel/);
  assert.match(markup, /settingsPage\.workspace\.general\.iconHint/);
  assert.match(markup, />AR</);
  assert.doesNotMatch(markup, /<input[^>]*type="file"/);
});

test("shows the user's own role", async (t) => {
  const module = await loadSection(t);

  for (const role of ["owner", "admin", "member"]) {
    const markup = render(module, { role });
    assert.match(markup, /settingsPage\.workspace\.general\.roleLabel/);
    assert.ok(markup.includes(`settingsPage.workspace.role.${role}`));
  }
});
