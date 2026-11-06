const test = require("node:test");
const assert = require("node:assert/strict");
const { createElement } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

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

async function loadSection(t) {
  t.after(() => {
    delete globalThis.__caps;
    delete globalThis.__settingsWorkspace;
  });
  installBrowserGlobals(t);
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
      "/lib/capabilities": `
        export const workspaceCan = (workspace, capability) =>
          globalThis.__caps?.[capability] === true;
      `,
      "/services/workspaceActions": `
        export const leaveWorkspace = async () => {};
        export const deleteWorkspace = async () => {};
        export const transferOwnership = async () => {};
      `,
      "/services/WorkspacesService": "export const WorkspacesService = {};",
      "/stores/workspaceStore": `
        export const useWorkspaceStore = (selector) => selector({ refresh: async () => {} });
      `,
      "/hooks/useAuth": "export const useAuth = () => ({ user: { id: 'u-self' } });",
      "/ui/useToast": "export const useToast = () => ({ toast: () => {} });",
      "/EnterpriseConsoleRow": "export default function Mock() { return null; }",
      "/WorkspaceExitDialog": `
        import React from "react";
        export function WorkspaceExitDialog() {
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

function render(module, { role, name = WORKSPACE.name, caps = ROLE_CAPS[role] }) {
  const workspace = { ...WORKSPACE, name, role };
  globalThis.__caps = caps;
  globalThis.__settingsWorkspace = {
    status: "ready",
    workspace,
    workspaces: [workspace],
    retry: () => {},
  };
  return renderToStaticMarkup(
    createElement(module.default, { onNavigateToSection: () => {}, onChooseWorkspace: () => {} })
  );
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
