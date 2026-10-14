const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

test("workspace parent choices preserve fallback focus and tab preferences", async (t) => {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    delete globalThis.__workspaceStore;
    delete globalThis.__createDialogMounts;
  });
  const { Window } = await import("happy-dom");
  const dom = new Window();
  const documentBefore = globalThis.document;
  const actBefore = globalThis.IS_REACT_ACT_ENVIRONMENT;
  installBrowserGlobals(t, { initialStorage: { "settings.workspaceTab": '"developer"' } });
  globalThis.window = dom;
  globalThis.document = dom.document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    root = null;
    globalThis.document = documentBefore;
    globalThis.IS_REACT_ACT_ENVIRONMENT = actBefore;
    await dom.happyDOM.close();
  });
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-workspace-section-test-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `export const useTranslation = () => ({ t: (key) => key });`,
      "/components/icons": `export const Users = () => null; export const UserPlus = () => null; export const Trash2 = () => null; export const LogOut = () => null; export const ChevronDown = () => null; export const Loader2 = () => null;`,
      "/stores/workspaceStore": `
        import { create } from "zustand";
        export const useWorkspaceStore = create((set) => ({
          workspaces: [{ id: "one", name: "One", role: "owner" }, { id: "two", name: "Two", role: "owner" }],
          activeWorkspaceId: "one", loaded: true, loading: false, error: false,
          setActiveWorkspaceId: (id) => set({ activeWorkspaceId: id }), refresh: async () => {},
        }));
        globalThis.__workspaceStore = useWorkspaceStore;
      `,
      "/hooks/useAuth": `export const useAuth = () => ({ isSignedIn: true });`,
      "/hooks/useDialogs": `export const useDialogs = () => ({ confirmDialog: { open: false } });`,
      "/services/WorkspacesService": `export const WorkspacesService = {};`,
      "/ui/button": `import React from "react"; export const Button = ({ children, ...props }) => React.createElement("button", props, children);`,
      "/ui/input": `export const Input = () => null;`,
      "/ui/SettingsSection": `export const SettingsPanel = () => null; export const SettingsPanelRow = () => null; export const SettingsRow = () => null;`,
      "/ui/useToast": `export const useToast = () => ({ toast() {} });`,
      "/ui/dialog": `export const ConfirmDialog = () => null;`,
      "/CreateWorkspaceDialog": `
        import React from "react";
        export default function CreateWorkspaceDialog() {
          React.useEffect(() => { globalThis.__createDialogMounts = (globalThis.__createDialogMounts ?? 0) + 1; }, []);
          return null;
        }
      `,
      "/InviteTeammateDialog": `export default function InviteTeammateDialog() { return null; }`,
      "/ui/dropdown-menu": `
        import React from "react";
        const W = ({ children }) => React.createElement("div", null, children);
        export const DropdownMenu = W; export const DropdownMenuTrigger = W;
        export const DropdownMenuContent = W; export const DropdownMenuItem = W;
        export const DropdownMenuLabel = W; export const DropdownMenuSeparator = W;
      `,
      "/lib/utils": `export const cn = (...names) => names.filter(Boolean).join(" ");`,
      "/lib/spacePermissions": `export const canManageWorkspace = (role) => role !== "member";`,
      "/WorkspaceMembersTab": `export default function WorkspaceMembersTab() { return null; }`,
      "/WorkspaceTeamsTab": `export default function WorkspaceTeamsTab() { return null; }`,
      "/WorkspaceDeveloperTab": `
        import React from "react";
        export default function WorkspaceDeveloperTab({ workspace }) {
          return React.createElement("div", null, workspace.id, React.createElement("input", {"aria-label": "Developer draft"}));
        }
      `,
      "/EnterpriseConsoleRow": `export default function EnterpriseConsoleRow() { return null; }`,
    },
  });
  const { default: WorkspaceSection } = await vite.ssrLoadModule(
    "/components/settings/WorkspaceSection.tsx"
  );
  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(WorkspaceSection)));

  const choices = () => [...container.querySelectorAll("[data-workspace-choice]")];
  const choice = (id) => choices().find((button) => button.dataset.workspaceChoice === id);
  // Change the selected workspace; child surrogates only exercise parent focus behavior.
  const role = (role) =>
    React.act(async () =>
      globalThis.__workspaceStore.setState((state) => ({
        workspaces: state.workspaces.map((workspace) =>
          workspace.id === state.activeWorkspaceId ? { ...workspace, role } : workspace
        ),
      }))
    );
  assert.equal(container.querySelector('[role="tab"]'), null);
  assert.equal(container.querySelector('[role="tablist"]'), null);
  assert.ok(choices().every((button) => button.type === "button" && button.tabIndex === 0));
  await React.act(async () => choice("developer").focus());
  await role("member");
  assert.equal(
    globalThis.document.activeElement,
    choice("members"),
    "removing a focused choice restores focus to the fallback"
  );
  assert.equal(choice("developer"), undefined);
  assert.equal(container.querySelector('input[aria-label="Developer draft"]'), null);
  await role("owner");
  await React.act(async () =>
    container.querySelector('input[aria-label="Developer draft"]').focus()
  );
  await role("member");
  assert.equal(
    globalThis.document.activeElement,
    choice("members"),
    "removed panel focus is restored before paint"
  );
  await role("owner");
  const outside = dom.document.createElement("button");
  dom.document.body.appendChild(outside);
  await React.act(async () => outside.focus());
  await role("member");
  assert.equal(
    globalThis.document.activeElement,
    outside,
    "role removal never steals unrelated focus"
  );
  await React.act(async () => choice("teams").click());
  assert.equal(choice("teams").getAttribute("aria-pressed"), "true");
  assert.equal(choice("members").getAttribute("aria-pressed"), "false");

  await React.act(async () => globalThis.__workspaceStore.setState({ workspaces: [] }));
  const mounts = globalThis.__createDialogMounts;
  await React.act(async () =>
    globalThis.__workspaceStore.setState({
      workspaces: [{ id: "new", name: "New", role: "owner" }],
      activeWorkspaceId: "new",
    })
  );
  assert.equal(
    globalThis.__createDialogMounts,
    mounts,
    "the first workspace landing keeps the create dialog mounted"
  );
});
