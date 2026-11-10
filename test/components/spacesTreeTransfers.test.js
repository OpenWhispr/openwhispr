const assert = require("node:assert/strict");
const test = require("node:test");
const React = require("react");
const { createRendererServer } = require("../lib/rendererTestHarness");

// Workspace A (active and default) with its Private (1) and teamspace Alpha (2); workspace B with
// its Private (4), which A's tree doesn't show.
const SPACES = [
  {
    id: 1,
    kind: "private",
    workspace_id: "a",
    account_id: "acc",
    name: "Personal",
    sync_status: "synced",
  },
  { id: 2, kind: "team", workspace_id: "a", name: "Alpha", sync_status: "synced", teams: [] },
  {
    id: 4,
    kind: "private",
    workspace_id: "b",
    account_id: "acc",
    name: "Personal",
    sync_status: "synced",
  },
];
const FOLDERS = [
  { id: 10, space_id: 1, name: "Plans", is_default: 0 },
  { id: 20, space_id: 2, name: "Specs", is_default: 0 },
];
const NOTES = [
  { id: 101, space_id: 1, folder_id: 10, title: "Plan", cloud_id: null },
  {
    id: 202,
    space_id: 2,
    folder_id: 20,
    title: "Spec",
    cloud_id: "cloud-202",
    owner_user_id: "user-2",
  },
];
const WORKSPACES = [
  { id: "a", name: "Acme", role: "member" },
  { id: "b", name: "Beta Corp", role: "member" },
];

async function mountTree(t) {
  let root;
  const original = {};
  let dom;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    await dom?.happyDOM.close();
    for (const [key, value] of Object.entries(original)) {
      if (value) Object.defineProperty(globalThis, key, value);
      else delete globalThis[key];
    }
    delete globalThis.__tree;
  });
  const { Window } = await import("happy-dom");
  dom = new Window({ url: "http://localhost:5173" });
  for (const key of [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "HTMLInputElement",
    "Node",
    "Element",
    "Event",
    "MouseEvent",
    "KeyboardEvent",
    "MutationObserver",
    "getComputedStyle",
    "localStorage",
    "requestAnimationFrame",
    "cancelAnimationFrame",
  ]) {
    original[key] = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, {
      value:
        typeof dom[key] === "function" &&
        (key.includes("AnimationFrame") || key === "getComputedStyle")
          ? dom[key].bind(dom)
          : dom[key],
      writable: true,
      configurable: true,
    });
  }
  original.IS_REACT_ACT_ENVIRONMENT = Object.getOwnPropertyDescriptor(
    globalThis,
    "IS_REACT_ACT_ENVIRONMENT"
  );
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;

  const state = { calls: [], toasts: [], dialogs: [], opened: [], moves: [] };
  globalThis.__tree = state;
  globalThis.window.electronAPI = {
    getPrivateSpaceId: async (workspaceId) => {
      state.calls.push(["getPrivateSpaceId", workspaceId ?? null]);
      return workspaceId === "b" ? 4 : 1;
    },
    copyNoteToSpace: async (noteId, spaceId, folderId) => {
      state.calls.push(["copyNoteToSpace", noteId, spaceId, folderId]);
      return { id: 900, space_id: spaceId, folder_id: 10, title: "Spec" };
    },
  };

  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-spaces-tree-transfers-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `import en from '/locales/en/translation.json';const t=(key,values={})=>{let s=key.split('.').reduce((v,k)=>v?.[k],en)??key;return String(s).replace(/{{(\\w+)}}/g,(_,k)=>values[k]??'');};export const useTranslation=()=>({t,i18n:{language:'en',dir:()=>'ltr'}});`,
      "/stores/noteStore": `
        const spaces = ${JSON.stringify(SPACES)};
        const folders = ${JSON.stringify(FOLDERS)};
        const notes = ${JSON.stringify(NOTES)};
        export const folderContainerKey = (id) => "folder:" + id;
        export const spaceContainerKey = (id) => "space:" + id;
        export const useSpaces = () => spaces;
        export const useFolders = () => folders;
        export const useFolderCounts = () => ({ 10: 1, 20: 1 });
        export const useSpaceRootCounts = () => ({});
        export const useNotesByContainer = () => ({
          "space:1": [], "space:2": [], "folder:10": [notes[0]], "folder:20": [notes[1]],
        });
        export const useExpandedContainers = () => new Set(["space:1", "space:2", "folder:10", "folder:20"]);
        export const useActiveContext = () => null;
        export const useActiveNoteId = () => null;
        export const useActiveNote = () => null;
        export const useIsTreeLoading = () => false;
        export const useShareCache = () => new Map();
        export const getNoteFromStore = (id) => notes.find((note) => note.id === id) ?? null;
        export const getFoldersValue = () => folders;
        export const getSpacesValue = () => spaces;
        export const setActiveContext = () => {};
        export const setActiveNoteId = () => {};
        export const setContainerExpanded = () => {};
        export const toggleContainerExpanded = () => {};
        export const revealContainer = () => {};
        export const openNote = (note) => globalThis.__tree.opened.push(note);
        export const createFolder = async () => ({ success: true });
        export const renameFolder = async () => ({ success: true });
        export const deleteFolder = async () => ({ success: true });
        export const moveFolderToSpace = async () => ({ success: true });
      `,
      "/hooks/useTeamSpacesCapability": "export const useTeamSpacesCapability = () => true;",
      "/hooks/useAuth":
        'export const useAuth = () => ({ isSignedIn: true, user: { id: "user-1" } });',
      "/hooks/useWorkspace": `
        const workspaces = ${JSON.stringify(WORKSPACES)};
        export const useWorkspace = () => ({
          workspaces, active: workspaces[0], loaded: true, defaultWorkspaceId: "a",
        });
        export const useSpacesInWorkspaceScope = (spaces) =>
          spaces.filter((space) => space.workspace_id === "a");
      `,
      "/hooks/useCanCreateTeamSpace": "export const useCanCreateTeamSpace = () => false;",
      "/hooks/useDialogs": `
        export const useDialogs = () => ({
          confirmDialog: { open: false },
          showConfirmDialog: (dialog) => globalThis.__tree.dialogs.push(dialog),
          hideConfirmDialog: () => {},
        });
      `,
      "/ui/useToast": `
        export const useToast = () => ({
          toast: (toast) => { globalThis.__tree.toasts.push(toast); return "toast"; },
          dismiss: () => {},
        });
      `,
      "/stores/settingsStore": `
        export const useSettingsStore = (selector) => selector({ noteFilesEnabled: false });
      `,
      "/utils/platform": 'export const getCachedPlatform = () => "darwin";',
      "/lib/capabilities": `
        export const spaceCan = () => false;
        export const workspaceCan = () => false;
      `,
      "/lib/notePermissions": `
        export const canOrganizeNote = () => true;
        export const resolveNotePermission = () => "owner";
        export const sharedNoteBlocksDelete = () => false;
      `,
      "/ui/dropdown-menu": `
        import React from "react";
        const pass = ({ children }) => React.createElement(React.Fragment, null, children);
        export const DropdownMenu = pass;
        export const DropdownMenuTrigger = pass;
        export const DropdownMenuContent = pass;
        export const DropdownMenuSub = pass;
        export const DropdownMenuSubTrigger = pass;
        export const DropdownMenuSubContent = pass;
        export const DropdownMenuSeparator = () => null;
        export const DropdownMenuItem = ({ children, onClick, onSelect, disabled }) =>
          React.createElement("button", {
            role: "menuitem",
            disabled,
            onClick: (event) => { onSelect?.(event); onClick?.(event); },
          }, children);
      `,
      "/ui/dialog": "export const ConfirmDialog = () => null;",
      "/CreateSpaceDialog": "export default function Mock() { return null; }",
      "/DeleteSpaceDialog": "export default function Mock() { return null; }",
      "/SpaceSettingsDialog": "export default function Mock() { return null; }",
    },
  });
  const { default: SpacesTree } = await vite.ssrLoadModule("/components/notes/SpacesTree.tsx");
  const { createRoot } = require("react-dom/client");
  const container = globalThis.document.createElement("div");
  globalThis.document.body.append(container);
  root = createRoot(container);
  await React.act(async () => {
    root.render(
      React.createElement(SpacesTree, {
        onDeleteNote: () => {},
        onMoveNote: async (noteId, target) => state.moves.push([noteId, target]),
        onCreateFolderAndMove: () => {},
        onNewNote: () => {},
      })
    );
  });

  const settle = () => React.act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  const noteRow = (title) => container.querySelector(`[role="treeitem"][title="${title}"]`);
  const menuItems = (title) =>
    [...noteRow(title).querySelectorAll('[role="menuitem"]')].map((item) =>
      item.textContent.trim()
    );
  const choose = async (title, label) => {
    const item = [...noteRow(title).querySelectorAll('[role="menuitem"]')].find(
      (candidate) => candidate.textContent.trim() === label
    );
    assert.ok(item, `${title} offers ${label}`);
    await React.act(async () =>
      item.dispatchEvent(new globalThis.window.MouseEvent("click", { bubbles: true }))
    );
    await settle();
  };
  // A native drag from a note row onto a drop target, carrying the note id as the tree sets it.
  const drag = async (source, target) => {
    const data = new Map();
    const dataTransfer = {
      effectAllowed: "",
      dropEffect: "",
      setData: (type, value) => data.set(type, value),
      getData: (type) => data.get(type) ?? "",
      setDragImage() {},
    };
    for (const [element, type] of [
      [source, "dragstart"],
      [target, "dragenter"],
      [target, "dragover"],
      [target, "drop"],
    ]) {
      const event = new globalThis.window.Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
      await React.act(async () => element.dispatchEvent(event));
    }
    await settle();
  };
  return { state, container, noteRow, menuItems, choose, drag, settle };
}

test("a team note copies to Private, and the toast's Open opens the copy", async (t) => {
  const tree = await mountTree(t);

  // Private is no move destination for a team note; Copy to Private is offered instead.
  const items = tree.menuItems("Spec");
  assert.ok(items.includes("Copy to Private"));
  assert.ok(!items.some((item) => item.startsWith("Move to ") && item.endsWith("› Private")));
  assert.ok(!items.includes("Plans"), "the Private section's folders aren't move targets");

  await tree.choose("Spec", "Copy to Private");
  assert.deepEqual(tree.state.calls, [
    ["getPrivateSpaceId", null],
    ["copyNoteToSpace", 202, 1, null],
  ]);
  assert.deepEqual(tree.state.moves, [], "the team keeps its note");
  assert.equal(tree.state.dialogs.length, 0, "an explicit copy asks nothing");
  const toast = tree.state.toasts.at(-1);
  assert.equal(toast.title, "Copied to Private");
  assert.deepEqual(
    toast.actions.map((action) => action.label),
    ["Open"]
  );
  toast.actions[0].onClick();
  assert.deepEqual(tree.state.opened, [{ id: 900, space_id: 1, folder_id: 10, title: "Spec" }]);
});

test("a private note moves to another workspace's Private, with Undo and no question", async (t) => {
  const tree = await mountTree(t);

  const items = tree.menuItems("Plan");
  assert.ok(items.includes("Move to Beta Corp › Private"));
  assert.ok(!items.includes("Move to Acme › Private"), "not the workspace it's already in");
  assert.ok(!items.includes("Copy to Private"));

  await tree.choose("Plan", "Move to Beta Corp › Private");
  assert.deepEqual(tree.state.calls, [["getPrivateSpaceId", "b"]]);
  assert.deepEqual(tree.state.moves, [[101, { spaceId: 4, folderId: null }]]);
  assert.equal(tree.state.dialogs.length, 0);
  const toast = tree.state.toasts.at(-1);
  assert.equal(toast.title, "Moved “Plan” to Beta Corp › Private");
  assert.deepEqual(
    toast.actions.map((action) => action.label),
    ["Undo"]
  );
});

test("a team note dropped on Private asks to copy it, then copies", async (t) => {
  const tree = await mountTree(t);
  const privateHeader = [...tree.container.querySelectorAll("button")].find((button) =>
    button.textContent.includes("Private notes")
  ).parentElement;

  await tree.drag(tree.noteRow("Spec"), privateHeader);
  assert.equal(tree.state.dialogs.length, 1);
  const dialog = tree.state.dialogs[0];
  assert.equal(dialog.title, "Copy to Private?");
  assert.equal(
    dialog.description,
    "The note stays in Alpha. The copy is private and stays on this device."
  );
  assert.equal(dialog.confirmText, "Copy");
  assert.deepEqual(tree.state.calls, [], "nothing happens before the answer");

  await React.act(async () => dialog.onConfirm());
  await tree.settle();
  assert.deepEqual(tree.state.calls, [["copyNoteToSpace", 202, 1, null]]);
  assert.deepEqual(tree.state.moves, []);
  assert.equal(tree.state.toasts.at(-1).title, "Copied to Private");
});
