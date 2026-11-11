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

// Mounts the tree over a live fixture: tests change `state.notes`, `state.folders` and the queued
// move answers between actions, as main and sync would.
async function mountTree(
  t,
  {
    spaces = SPACES,
    folders = FOLDERS,
    notes = NOTES,
    expanded = ["space:1", "space:2", "folder:10", "folder:20"],
    inScopeIds = [1, 2],
    defaultWorkspaceId = "a",
    onFlushPendingSaves,
  } = {}
) {
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

  const state = {
    calls: [],
    toasts: [],
    dialogs: [],
    opened: [],
    moves: [],
    folderMoves: [],
    // What onMoveNote and moveFolderToSpace answer next; empty means success.
    moveResults: [],
    folderMoveResults: [],
    spaces: structuredClone(spaces),
    folders: structuredClone(folders),
    notes: structuredClone(notes),
  };
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
        const s = () => globalThis.__tree;
        export const folderContainerKey = (id) => "folder:" + id;
        export const spaceContainerKey = (id) => "space:" + id;
        export const useSpaces = () => s().spaces;
        export const useFolders = () => s().folders;
        export const useFolderCounts = () => Object.fromEntries(
          s().folders.map((f) => [f.id, s().notes.filter((n) => n.folder_id === f.id).length])
        );
        export const useSpaceRootCounts = () => ({});
        export const useNotesByContainer = () => Object.fromEntries([
          ...s().spaces.map((sp) => ["space:" + sp.id,
            s().notes.filter((n) => n.space_id === sp.id && n.folder_id == null)]),
          ...s().folders.map((f) => ["folder:" + f.id, s().notes.filter((n) => n.folder_id === f.id)]),
        ]);
        export const useExpandedContainers = () => new Set(${JSON.stringify(expanded)});
        export const useActiveContext = () => null;
        export const useActiveNoteId = () => null;
        export const useActiveNote = () => null;
        export const useIsTreeLoading = () => false;
        export const useShareCache = () => new Map();
        export const getNoteFromStore = (id) => s().notes.find((note) => note.id === id) ?? null;
        export const getFoldersValue = () => s().folders;
        export const getSpacesValue = () => s().spaces;
        export const setActiveContext = () => {};
        export const setActiveNoteId = () => {};
        export const setContainerExpanded = () => {};
        export const toggleContainerExpanded = () => {};
        export const revealContainer = () => {};
        export const openNote = (note) => globalThis.__tree.opened.push(note);
        export const createFolder = async () => ({ success: true });
        export const renameFolder = async () => ({ success: true });
        export const deleteFolder = async () => ({ success: true });
        export const moveFolderToSpace = async (folderId, spaceId) => {
          s().folderMoves.push([folderId, spaceId]);
          const refused = s().folderMoveResults.shift();
          if (refused) return refused;
          const folder = s().folders.find((f) => f.id === folderId);
          if (folder) folder.space_id = spaceId;
          return { success: true };
        };
      `,
      "/hooks/useTeamSpacesCapability": "export const useTeamSpacesCapability = () => true;",
      "/hooks/useAuth":
        'export const useAuth = () => ({ isSignedIn: true, user: { id: "user-1" } });',
      "/hooks/useWorkspace": `
        const workspaces = ${JSON.stringify(WORKSPACES)};
        export const useWorkspace = () => ({
          workspaces, active: workspaces[0], loaded: true,
          defaultWorkspaceId: ${JSON.stringify(defaultWorkspaceId)},
        });
        export const useSpacesInWorkspaceScope = (spaces) =>
          spaces.filter((space) => ${JSON.stringify(inScopeIds)}.includes(space.id));
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
        onFlushPendingSaves,
        onMoveNote: async (noteId, target) => {
          state.moves.push([noteId, target]);
          return state.moveResults.shift();
        },
        onCreateFolderAndMove: () => {},
        onNewNote: () => {},
      })
    );
  });

  const settle = () => React.act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  const noteRow = (title) => container.querySelector(`[role="treeitem"][title="${title}"]`);
  const menuItem = (title, label) =>
    [...noteRow(title).querySelectorAll('[role="menuitem"]')].find(
      (candidate) => candidate.textContent.trim() === label
    );
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
  // Runs the latest toast's action labelled `label` (Undo, Open).
  const runToastAction = async (label) => {
    const action = state.toasts
      .filter((toast) => toast.actions)
      .at(-1)
      ?.actions.find((candidate) => candidate.label === label);
    assert.ok(action, `the toast offers ${label}`);
    await React.act(async () => action.onClick());
    await settle();
  };
  const confirmLastDialog = async () => {
    await React.act(async () => state.dialogs.at(-1).onConfirm());
    await settle();
  };
  return {
    state,
    container,
    noteRow,
    menuItem,
    menuItems,
    choose,
    drag,
    settle,
    runToastAction,
    confirmLastDialog,
  };
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
  const privateHeader = [...tree.container.querySelectorAll("button")].find(
    (button) => button.textContent.trim() === "Private"
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

const ALREADY_IN_ALPHA = "“Plan” is already in Alpha. Use Copy to Private to keep a private copy.";

// Moves "Plan" (Private › Plans) into Alpha › Specs through its menu, confirming the question.
async function movePlanIntoAlpha(tree) {
  await tree.choose("Plan", "Specs");
  assert.equal(tree.state.dialogs.at(-1).title, "Move to Alpha?");
  await tree.confirmLastDialog();
  assert.deepEqual(tree.state.moves.at(-1), [101, { spaceId: 2, folderId: 20 }]);
  assert.equal(tree.state.toasts.at(-1).title, "Moved “Plan” to Specs");
}

test("Undo after the note reached the teamspace says why instead of moving it", async (t) => {
  const tree = await mountTree(t);
  await movePlanIntoAlpha(tree);

  // The team pass ran (2 s after the move): the note is Alpha's in the cloud now.
  Object.assign(tree.state.notes[0], { space_id: 2, folder_id: 20, cloud_id: "cloud-101" });
  await tree.runToastAction("Undo");
  assert.equal(tree.state.moves.length, 1, "no move back out of the teamspace");
  assert.equal(tree.state.toasts.at(-1).title, ALREADY_IN_ALPHA);
});

test("a move main refuses never says Moved, and gives main's reason", async (t) => {
  const tree = await mountTree(t);
  await movePlanIntoAlpha(tree);

  // This window hasn't seen the upload yet; main has, and refuses the Undo (D31).
  Object.assign(tree.state.notes[0], { space_id: 2, folder_id: 20 });
  tree.state.moveResults.push({ success: false, code: "team_row_synced", error: "x" });
  const toastsBefore = tree.state.toasts.length;
  await tree.runToastAction("Undo");
  assert.equal(tree.state.moves.length, 2, "the Undo reached main");
  const after = tree.state.toasts.slice(toastsBefore);
  assert.deepEqual(
    after.map((toast) => toast.title),
    [ALREADY_IN_ALPHA]
  );

  // Any other refusal: a failure with its reason, and no Undo to offer.
  Object.assign(tree.state.notes[0], { space_id: 1, folder_id: 10, cloud_id: null });
  tree.state.moveResults.push({ success: false, error: "Space not found" });
  await tree.choose("Plan", "Specs");
  await tree.confirmLastDialog();
  const refused = tree.state.toasts.at(-1);
  assert.equal(refused.title, "Couldn't move note");
  assert.equal(refused.description, "That space could not be found.");
  assert.equal(refused.actions, undefined);
});

test("folder Undo is refused for a folder that reached the teamspace, saying why", async (t) => {
  const tree = await mountTree(t);
  await tree.choose("Plans", "Alpha");
  assert.equal(tree.state.dialogs.at(-1).title, "Move to Alpha?");
  await tree.confirmLastDialog();
  assert.deepEqual(tree.state.folderMoves, [[10, 2]]);
  assert.equal(tree.state.toasts.at(-1).title, "Moved “Plans” to Alpha");

  // Main refuses the way back once the folder or a note in it is in the cloud (D31).
  tree.state.folderMoveResults.push({ success: false, code: "team_row_synced", error: "x" });
  await tree.runToastAction("Undo");
  assert.deepEqual(tree.state.folderMoves, [
    [10, 2],
    [10, 1],
  ]);
  assert.equal(
    tree.state.toasts.at(-1).title,
    "“Plans” is already in Alpha. Use Copy to Private on its notes to keep private copies."
  );
});

// The default workspace's own Private (1), the pending one (9) until main binds it, and Alpha.
const MERGED_SPACES = [
  SPACES[0],
  { id: 9, kind: "private", workspace_id: null, account_id: "acc", name: "Personal" },
  SPACES[1],
];

test("a folder of either Private shows the Private section as its place, never a destination", async (t) => {
  const tree = await mountTree(t, {
    spaces: MERGED_SPACES,
    folders: [...FOLDERS, { id: 91, space_id: 9, name: "Ideas", is_default: 0 }],
    inScopeIds: [1, 9, 2],
  });
  for (const folder of ["Ideas", "Plans"]) {
    const ownSection = tree.menuItem(folder, "Private");
    assert.ok(ownSection, `${folder} lists the Private section`);
    assert.equal(ownSection.disabled, true, `${folder} is already there`);
    assert.equal(tree.menuItem(folder, "Alpha").disabled, false);
  }
  await tree.choose("Ideas", "Private");
  assert.deepEqual(
    tree.state.folderMoves,
    [],
    "moving between the section's Privates does nothing"
  );
  assert.deepEqual(tree.state.dialogs, []);
});

test("while the default workspace is unknown, a note doesn't cross the Private section's Privates", async (t) => {
  const pendingNote = { id: 900, space_id: 9, folder_id: null, title: "Pending note" };
  const tree = await mountTree(t, {
    spaces: MERGED_SPACES.slice(0, 2),
    folders: [FOLDERS[0]],
    notes: [NOTES[0], pendingNote],
    inScopeIds: [1, 9],
    expanded: ["space:1", "folder:10"],
    defaultWorkspaceId: null,
  });
  const loading = "Your workspaces are still loading. Try again in a moment.";

  // "Plans" is only the workspace's own Private's; the pending one may be another workspace's.
  await tree.choose("Pending note", "Plans");
  assert.equal(tree.state.toasts.at(-1).title, loading);
  await tree.drag(tree.noteRow("Pending note"), tree.noteRow("Plans"));
  assert.equal(tree.state.toasts.at(-1).title, loading);
  assert.deepEqual(tree.state.moves, []);
  assert.deepEqual(tree.state.dialogs, []);
});

test("a private note dropped on a teamspace of no workspace says why it can't go there", async (t) => {
  const legacy = { id: 6, kind: "team", workspace_id: null, name: "Legacy", teams: [] };
  const tree = await mountTree(t, {
    spaces: [SPACES[0], legacy],
    folders: [FOLDERS[0]],
    notes: [NOTES[0]],
    inScopeIds: [1, 6],
    expanded: ["space:1", "folder:10"],
  });

  await tree.drag(tree.noteRow("Plan"), tree.noteRow("Legacy"));
  assert.equal(
    tree.state.toasts.at(-1).title,
    "Notes can't move into Legacy: it isn't part of a workspace."
  );
  assert.deepEqual(tree.state.moves, []);
  assert.deepEqual(tree.state.dialogs, []);
});

for (const route of ["menu", "drop"]) {
  test(`copy to Private flushes the source draft before ${route} copying and aborts failed saves`, async (t) => {
    let fail = false;
    let tree;
    tree = await mountTree(t, {
      onFlushPendingSaves: async (noteId) => {
        assert.equal(noteId, 202);
        assert.equal(tree.state.calls.filter((call) => call[0] === "copyNoteToSpace").length, 0);
        if (fail) throw new Error("save refused");
        tree.state.notes.find((note) => note.id === noteId).content = "Latest draft";
      },
    });
    const copy = async () => {
      if (route === "menu") await tree.choose("Spec", "Copy to Private");
      else {
        const header = [...tree.container.querySelectorAll("button")].find(
          (button) => button.textContent.trim() === "Private"
        ).parentElement;
        await tree.drag(tree.noteRow("Spec"), header);
        await tree.confirmLastDialog();
      }
    };
    fail = true;
    await copy();
    assert.equal(tree.state.calls.filter((call) => call[0] === "copyNoteToSpace").length, 0);
    assert.equal(tree.state.toasts.at(-1).title, "Couldn't copy note");
    fail = false;
    await copy();
    assert.equal(tree.state.notes.find((note) => note.id === 202).content, "Latest draft");
    assert.equal(tree.state.calls.filter((call) => call[0] === "copyNoteToSpace").length, 1);
  });
}
