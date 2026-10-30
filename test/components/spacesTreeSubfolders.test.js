// The sidebar draws its rows twice: as JSX, and as the flat row list keyboard
// navigation walks. Subfolders must land in the same place in both.
const assert = require("node:assert/strict");
const test = require("node:test");
const React = require("react");
const i18next = require("i18next");
const { initReactI18next } = require("react-i18next");
const { createRendererServer } = require("../lib/rendererTestHarness");
const en = require("../../src/locales/en/translation.json");

const GLOBALS = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "Node",
  "Element",
  "Event",
  "KeyboardEvent",
  "MouseEvent",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
];

const folder = (id, space_id, name, parent_folder_id = null) => ({
  id,
  space_id,
  name,
  is_default: 0,
  parent_folder_id,
});

// Subfolders come first, as main's sort order may list them. Q1 and Roadmap
// hold more notes than the sidebar shows, so they get a "more" row.
const WITH_SUBFOLDERS = {
  folders: [
    folder(12, 1, "Q1", 11),
    folder(11, 1, "Work"),
    folder(22, 2, "Roadmap", 21),
    folder(21, 2, "Planning"),
  ],
  counts: { 11: 1, 12: 8, 21: 1, 22: 8 },
};

const WITHOUT_SUBFOLDERS = {
  folders: [folder(11, 1, "Work"), folder(21, 2, "Planning")],
  counts: { 11: 8, 21: 8 },
};

// Each folder holds one loaded note, and each space one root note.
const NOTE_STORE = `
  const spaces = [
    { id: 1, kind: "private", name: "Personal", sync_status: "synced" },
    { id: 2, kind: "team", name: "Engineering", sync_status: "synced" },
  ];
  const { folders, counts } = globalThis.__tree;
  const note = (id, space_id, folder_id, title) =>
    ({ id, space_id, folder_id, title, updated_at: "2026-10-28 09:00:00" });
  const notesByContainer = {
    "s:1": [note(100, 1, null, "Loose note")],
    "s:2": [note(200, 2, null, "Team loose note")],
    ...Object.fromEntries(
      folders.map((f) => ["f:" + f.id, [note(1000 + f.id, f.space_id, f.id, f.name + " note")]])
    ),
  };
  const notes = Object.values(notesByContainer).flat();
  export const folderContainerKey = (id) => "f:" + id;
  export const spaceContainerKey = (id) => "s:" + id;
  export const useSpaces = () => spaces;
  export const useFolders = () => folders;
  export const useFolderCounts = () => counts;
  export const useSpaceRootCounts = () => ({ 1: 1, 2: 1 });
  export const useNotesByContainer = () => notesByContainer;
  export const useExpandedContainers = () => new Set(Object.keys(notesByContainer));
  export const useActiveContext = () => null;
  export const useActiveNoteId = () => null;
  export const useActiveNote = () => null;
  export const useIsTreeLoading = () => false;
  export const useShareCache = () => new Map();
  export const getNoteFromStore = (id) => notes.find((n) => n.id === id) ?? null;
  export const getFoldersValue = () => folders;
  export const getSpacesValue = () => spaces;
  export const setActiveContext = () => {};
  export const setActiveNoteId = () => {};
  export const setContainerExpanded = () => {};
  export const toggleContainerExpanded = () => {};
  export const revealContainer = () => {};
  export const loadContainerNotes = async () => [];
  const record = (name) => async (...args) => {
    globalThis.__calls.push([name, ...args]);
    return { success: true };
  };
  export const createFolder = record("createFolder");
  export const renameFolder = async () => ({ success: true });
  export const deleteFolder = async () => ({ success: true });
  export const moveFolderToSpace = record("moveFolderToSpace");
  export const setFolderParent = record("setFolderParent");
`;

const MOCKS = {
  "/stores/noteStore": NOTE_STORE,
  "/hooks/useNoteDragAndDrop": `
    export const useNoteDragAndDrop = () => ({
      dragState: { draggingNoteId: null, dragOverKey: null, dropSuccessKey: null },
      noteDragHandlers: () => ({ draggable: true, onDragStart: () => {}, onDragEnd: () => {} }),
      dropTargetHandlers: () => ({}),
    });
  `,
  "/hooks/useTeamSpacesCapability": "export const useTeamSpacesCapability = () => true;",
  "/hooks/useAuth": "export const useAuth = () => ({ isSignedIn: false, user: null });",
  "/hooks/useWorkspace": "export const useWorkspace = () => ({ workspaces: [], loaded: true });",
  "/hooks/useCanCreateTeamSpace": "export const useCanCreateTeamSpace = () => false;",
  "/hooks/useDialogs": `
    export const useDialogs = () => ({
      confirmDialog: { open: false },
      showConfirmDialog: (dialog) => globalThis.__confirmDialogs.push(dialog),
      hideConfirmDialog: () => {},
    });
  `,
  "/ui/useToast": `
    export const useToast = () => ({
      toast: (props) => {
        globalThis.__toasts.push(props);
        return "toast";
      },
      dismiss: () => {},
    });
  `,
  "/stores/settingsStore":
    "export const useSettingsStore = (selector) => selector({ noteFilesEnabled: false });",
  "/utils/platform": 'export const getCachedPlatform = () => "darwin";',
  "/lib/spacePermissions": `
    export const canChangeSpaceNoteScope = () => true;
    export const canDeleteSpaceNote = () => true;
    export const canMoveBetweenSpaces = () => true;
    export const canMoveOrDeleteSpaceFolder = () => true;
  `,
  "/lib/capabilities":
    "export const spaceCan = () => true; export const workspaceCan = () => true;",
  "/lib/notePermissions": `
    export const canOrganizeNote = () => true;
    export const resolveNotePermission = () => "owner";
    export const sharedNoteBlocksDelete = () => false;
  `,
  // Every menu renders open inside its row. Picking an item closes the menu,
  // which then runs its onCloseAutoFocus, as Radix does.
  "/ui/dropdown-menu": `
    import { createElement } from "react";
    const div = (props) => ({ children }) => createElement("div", props, children);
    export const DropdownMenu = ({ children }) => children;
    export const DropdownMenuTrigger = ({ children }) => children;
    export const DropdownMenuContent = ({ children, onCloseAutoFocus }) =>
      createElement(
        "div",
        {
          role: "menu",
          onClickCapture: () =>
            queueMicrotask(() => onCloseAutoFocus?.({ preventDefault: () => {} })),
        },
        children
      );
    export const DropdownMenuItem = ({ children, disabled, onClick, onSelect }) =>
      createElement("button", { role: "menuitem", disabled, onClick: onClick ?? onSelect }, children);
    export const DropdownMenuSub = div({ "data-submenu": "" });
    export const DropdownMenuSubTrigger = div({ role: "menuitem" });
    export const DropdownMenuSubContent = div({});
    export const DropdownMenuSeparator = () => null;
  `,
  "/ui/dialog": "export const ConfirmDialog = () => null;",
  "/CreateSpaceDialog": "export default function Mock() { return null; }",
  "/DeleteSpaceDialog": "export default function Mock() { return null; }",
  "/SpaceSettingsDialog": "export default function Mock() { return null; }",
};

async function mountTree(t, tree) {
  const original = {};
  let root;
  let dom;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    await dom?.happyDOM.close();
    for (const [key, value] of Object.entries(original)) {
      if (value) Object.defineProperty(globalThis, key, value);
      else delete globalThis[key];
    }
    delete globalThis.__confirmDialogs;
    delete globalThis.__tree;
    delete globalThis.__calls;
    delete globalThis.__toasts;
  });
  const { Window } = await import("happy-dom");
  dom = new Window({ url: "http://localhost:5173" });
  for (const key of [...GLOBALS, "IS_REACT_ACT_ENVIRONMENT"]) {
    original[key] = Object.getOwnPropertyDescriptor(globalThis, key);
  }
  for (const key of GLOBALS) {
    const value = dom[key];
    const bind = typeof value === "function" && /AnimationFrame|getComputedStyle/.test(key);
    Object.defineProperty(globalThis, key, {
      value: bind ? value.bind(dom) : value,
      writable: true,
      configurable: true,
    });
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.__confirmDialogs = [];
  globalThis.__tree = tree;
  globalThis.__calls = [];
  globalThis.__toasts = [];
  globalThis.window.electronAPI = {};

  const i18n = i18next.createInstance();
  await i18n.use(initReactI18next).init({
    lng: "en",
    resources: { en: { translation: en } },
    initImmediate: false,
    interpolation: { escapeValue: false },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-spaces-tree-subfolders-",
    mockModules: MOCKS,
  });
  const { I18nextProvider } = await vite.ssrLoadModule("react-i18next");
  const { default: SpacesTree } = await vite.ssrLoadModule("/components/notes/SpacesTree.tsx");
  const { createRoot } = require("react-dom/client");
  const container = globalThis.document.createElement("div");
  globalThis.document.body.append(container);
  root = createRoot(container);
  await React.act(async () => {
    root.render(
      React.createElement(
        I18nextProvider,
        { i18n },
        React.createElement(SpacesTree, {
          onDeleteNote: () => {},
          onMoveNote: async () => {},
          onCreateFolderAndMove: () => {},
          onNewNote: () => {},
        })
      )
    );
  });
  return [...container.querySelectorAll('[role="treeitem"]')];
}

const focus = (row) => React.act(async () => row.focus());

const keyDown = (key) =>
  React.act(async () => {
    globalThis.document.activeElement.dispatchEvent(
      new globalThis.KeyboardEvent("keydown", { key, metaKey: key === "Backspace", bubbles: true })
    );
  });

const rowTitled = (rows, title) => rows.find((row) => row.getAttribute("title") === title);

const menuItems = (row) => [...row.querySelectorAll('[role="menuitem"]')];

const menuLabels = (row) => menuItems(row).map((item) => item.textContent.trim());

const menuItem = (row, label) => menuItems(row).find((item) => item.textContent.trim() === label);

const click = (element) => React.act(async () => element.click());

const rowSummary = (rows) =>
  rows.map((row) => [
    row.getAttribute("title") ?? row.getAttribute("aria-label"),
    row.getAttribute("aria-level"),
    row.className.split(" ").find((name) => name.startsWith("ps-")) ?? null,
  ]);

test("rows without subfolders keep the indents they had before subfolders", async (t) => {
  const rows = await mountTree(t, WITHOUT_SUBFOLDERS);

  assert.deepEqual(rowSummary(rows), [
    ["Work", "1", "ps-2"],
    ["Work note", "2", "ps-8"],
    ["7 more", "2", "ps-8"],
    ["Loose note", "1", "ps-[30px]"],
    ["Engineering", "1", null],
    ["Planning", "2", "ps-[14px]"],
    ["Planning note", "3", "ps-10"],
    ["7 more", "3", "ps-[42px]"],
    ["Team loose note", "2", "ps-[14px]"],
  ]);
});

test("a subfolder sits with its parent's notes, and its own rows one step further in", async (t) => {
  const rows = await mountTree(t, WITH_SUBFOLDERS);

  assert.deepEqual(rowSummary(rows), [
    ["Work", "1", "ps-2"],
    ["Q1", "2", "ps-8"],
    ["Q1 note", "3", "ps-14"],
    ["7 more", "3", "ps-14"],
    ["Work note", "2", "ps-8"],
    ["Loose note", "1", "ps-[30px]"],
    ["Engineering", "1", null],
    ["Planning", "2", "ps-[14px]"],
    ["Roadmap", "3", "ps-10"],
    ["Roadmap note", "4", "ps-16"],
    ["7 more", "4", "ps-16"],
    ["Planning note", "3", "ps-10"],
    ["Team loose note", "2", "ps-[14px]"],
  ]);
});

test("arrow keys walk the rows in the order they render", async (t) => {
  const rows = await mountTree(t, WITH_SUBFOLDERS);

  await focus(rows[0]);
  const visited = [globalThis.document.activeElement];
  for (let i = 1; i < rows.length; i += 1) {
    await keyDown("ArrowDown");
    visited.push(globalThis.document.activeElement);
  }

  assert.deepEqual(visited, rows);
});

test("deleting a parent folder counts its subfolders and all their notes", async (t) => {
  const rows = await mountTree(t, WITH_SUBFOLDERS);

  await focus(rows.find((row) => row.getAttribute("title") === "Work"));
  await keyDown("Backspace");

  assert.equal(
    globalThis.__confirmDialogs.at(-1).description,
    'This will permanently delete "Work", including 1 subfolder and 9 notes. This cannot be undone.'
  );
});

test("deleting a parent folder counts its subfolders even when no notes are in them", async (t) => {
  const rows = await mountTree(t, { ...WITH_SUBFOLDERS, counts: {} });

  await focus(rowTitled(rows, "Work"));
  await keyDown("Backspace");

  assert.equal(
    globalThis.__confirmDialogs.at(-1).description,
    'This will permanently delete "Work", including 1 subfolder and 0 notes. This cannot be undone.'
  );
});

test("only a top-level folder offers New subfolder, and only one without subfolders can move into a folder", async (t) => {
  const rows = await mountTree(t, {
    folders: [...WITH_SUBFOLDERS.folders, folder(13, 1, "Ideas")],
    counts: { ...WITH_SUBFOLDERS.counts, 13: 1 },
  });

  const work = menuLabels(rowTitled(rows, "Work"));
  const q1 = menuLabels(rowTitled(rows, "Q1"));
  const ideas = menuLabels(rowTitled(rows, "Ideas"));
  assert.ok(work.includes("New subfolder"));
  assert.ok(!work.includes("Move to folder"));
  assert.ok(!q1.includes("New subfolder"));
  assert.ok(q1.includes("Move to folder"));
  assert.ok(ideas.includes("Move to folder"));
});

test("Move to folder offers Top level and the space's top-level folders, the current parent ticked", async (t) => {
  const rows = await mountTree(t, WITH_SUBFOLDERS);

  const submenu = [...rowTitled(rows, "Q1").querySelectorAll("[data-submenu]")].find(
    (sub) => sub.firstChild.textContent.trim() === "Move to folder"
  );
  assert.deepEqual(
    [...submenu.querySelectorAll("button")].map((item) => [
      item.textContent,
      item.disabled,
      item.querySelector("svg") !== null,
    ]),
    [
      ["Top level", false, false],
      ["Work", true, true],
    ]
  );
});

test("New subfolder creates the folder inside its parent", async (t) => {
  const rows = await mountTree(t, WITH_SUBFOLDERS);

  await click(menuItem(rowTitled(rows, "Work"), "New subfolder"));
  const input = globalThis.document.querySelector('input[placeholder="Folder name"]');
  await React.act(async () => {
    Object.getOwnPropertyDescriptor(globalThis.window.HTMLInputElement.prototype, "value").set.call(
      input,
      "Q2"
    );
    input.dispatchEvent(new globalThis.window.Event("input", { bubbles: true }));
  });
  await React.act(async () => {
    input.dispatchEvent(new globalThis.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });

  assert.deepEqual(globalThis.__calls, [["createFolder", "Q2", 1, 11]]);
});

test("moving a subfolder to the top level can be undone", async (t) => {
  const rows = await mountTree(t, WITH_SUBFOLDERS);

  await click(menuItem(rowTitled(rows, "Q1"), "Top level"));
  const moved = globalThis.__toasts.at(-1);
  await React.act(async () => moved.action.props.onClick());

  assert.equal(moved.title, "Moved \u201cQ1\u201d to Top level");
  assert.deepEqual(globalThis.__calls, [
    ["setFolderParent", 12, null],
    ["setFolderParent", 12, 11],
  ]);
});

test("a parent moved to another space can be undone, a subfolder moved on its own can't", async (t) => {
  const rows = await mountTree(t, WITH_SUBFOLDERS);
  const moveToEngineering = async (title) => {
    await click(menuItem(rowTitled(rows, title), "Engineering"));
    await React.act(async () => globalThis.__confirmDialogs.at(-1).onConfirm());
  };

  await moveToEngineering("Work");
  const moved = globalThis.__toasts.at(-1);
  await React.act(async () => moved.action.props.onClick());
  await moveToEngineering("Q1");

  assert.equal(moved.title, "Moved \u201cWork\u201d to Engineering");
  assert.equal(globalThis.__toasts.length, 1);
  assert.deepEqual(globalThis.__calls, [
    ["moveFolderToSpace", 11, 2],
    ["moveFolderToSpace", 11, 1],
    ["moveFolderToSpace", 12, 2],
  ]);
});
