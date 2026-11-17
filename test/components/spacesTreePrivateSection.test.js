const assert = require("node:assert/strict");
const test = require("node:test");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const i18next = require("i18next");
const { initReactI18next } = require("react-i18next");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// The default workspace's own Private (1) and the pending one (9), both in scope until main binds
// the pending one into it, plus a teamspace.
const SPACES = [
  { id: 1, kind: "private", workspace_id: "a", name: "Personal", sync_status: "synced" },
  { id: 9, kind: "private", workspace_id: null, name: "Personal", sync_status: "synced" },
  { id: 2, kind: "team", workspace_id: "a", name: "Engineering", sync_status: "synced" },
];
const FOLDERS = [
  { id: 10, space_id: 1, name: "Plans", is_default: 0 },
  { id: 90, space_id: 9, name: "Plans", is_default: 0 },
  { id: 91, space_id: 9, name: "Ideas", is_default: 0 },
  { id: 20, space_id: 2, name: "Team folder", is_default: 0 },
];
const NOTES = [
  { id: 100, space_id: 1, folder_id: 10, title: "Own plan" },
  { id: 101, space_id: 1, folder_id: null, title: "Own loose note" },
  { id: 900, space_id: 9, folder_id: 90, title: "Pending plan" },
  { id: 910, space_id: 9, folder_id: 91, title: "Pending idea" },
  { id: 901, space_id: 9, folder_id: null, title: "Pending loose note" },
];
const EXPANDED = ["space:1", "space:2", "folder:10", "folder:91"];
const NO_DEVICE_NOTES = { folders: [], notes: [], viewNoteId: null };

async function renderTree(t, deviceNotes = NO_DEVICE_NOTES) {
  installBrowserGlobals(t);
  const i18n = i18next.createInstance();
  await i18n.use(initReactI18next).init({
    lng: "en",
    fallbackLng: "en",
    resources: {
      en: {
        translation: {
          notes: {
            deviceNotes: { title: "On this device" },
            spaces: { noteCount_one: "{{count}} note", noteCount_other: "{{count}} notes" },
          },
        },
      },
    },
    initImmediate: false,
    interpolation: { escapeValue: false },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-spaces-tree-private-section-",
    mockModules: {
      "/stores/noteStore": `
        const spaces = ${JSON.stringify(SPACES)};
        const folders = ${JSON.stringify(FOLDERS)};
        const notes = ${JSON.stringify(NOTES)};
        export const folderContainerKey = (id) => "folder:" + id;
        export const spaceContainerKey = (id) => "space:" + id;
        export const useSpaces = () => spaces;
        export const useFolders = () => folders;
        export const useFolderCounts = () =>
          Object.fromEntries(folders.map((f) => [f.id, notes.filter((n) => n.folder_id === f.id).length]));
        export const useSpaceRootCounts = () => ({});
        export const useNotesByContainer = () => Object.fromEntries([
          ...spaces.map((s) => ["space:" + s.id, notes.filter((n) => n.space_id === s.id && n.folder_id == null)]),
          ...folders.map((f) => ["folder:" + f.id, notes.filter((n) => n.folder_id === f.id)]),
        ]);
        // The section and its folder rows are open; the pending Private's own keys aren't.
        export const useExpandedContainers = () => new Set(${JSON.stringify(EXPANDED)});
        export const useActiveContext = () => null;
        export const useActiveNoteId = () => null;
        export const useActiveNote = () => null;
        export const useIsTreeLoading = () => false;
        export const useShareCache = () => new Map();
        export const getNoteFromStore = (id) => notes.find((note) => note.id === id);
        export const getFoldersValue = () => folders;
        export const getSpacesValue = () => spaces;
        export const setActiveContext = () => {};
        export const setActiveNoteId = () => {};
        export const setContainerExpanded = () => {};
        export const toggleContainerExpanded = () => {};
        export const revealContainer = () => {};
        export const createFolder = async () => ({ success: true });
        export const renameFolder = async () => ({ success: true });
        export const deleteFolder = async () => ({ success: true });
        export const moveFolderToSpace = async () => ({ success: true });
      `,
      "/hooks/useNoteDragAndDrop": `
        export const useNoteDragAndDrop = () => ({
          dragState: { draggingNoteId: null, dragOverKey: null, dropSuccessKey: null },
          noteDragHandlers: () => ({ draggable: true, onDragStart: () => {}, onDragEnd: () => {} }),
          dropTargetHandlers: () => ({
            onDragOver: () => {}, onDragEnter: () => {}, onDragLeave: () => {}, onDrop: () => {}
          }),
        });
      `,
      "/hooks/useTeamSpacesCapability": "export const useTeamSpacesCapability = () => true;",
      "/hooks/useAuth": "export const useAuth = () => ({ isSignedIn: false, user: null });",
      "/hooks/useWorkspace": `
        export const useWorkspace = () => ({ workspaces: [], loaded: true });
        export const useSpacesInWorkspaceScope = (spaces) => spaces;
      `,
      "/hooks/useCanCreateTeamSpace": "export const useCanCreateTeamSpace = () => false;",
      "/hooks/useDialogs": `
        export const useDialogs = () => ({
          confirmDialog: { open: false },
          showConfirmDialog: () => {},
          hideConfirmDialog: () => {},
        });
      `,
      "/ui/useToast": `
        export const useToast = () => ({ toast: () => "toast", dismiss: () => {} });
      `,
      "/stores/settingsStore": `
        export const useSettingsStore = (selector) => selector({ noteFilesEnabled: true });
      `,
      "/utils/platform": 'export const getCachedPlatform = () => "darwin";',
      "/services/spaceActions": `
        export const deleteSpace = async () => ({ success: true });
        export const renameSpace = async () => ({ success: true });
      `,
      "/lib/spacePermissions": `
        export const canChangeSpaceNoteScope = () => true;
        export const canDeleteSpaceNote = () => true;
        export const spaceTransferAction = () => "move";
        export const canMoveOrDeleteSpaceFolder = () => true;
      `,
      "/lib/capabilities": `
        export const spaceCan = () => true;
        export const workspaceCan = () => true;
      `,
      "/lib/notePermissions": `
        export const canOrganizeNote = () => true;
        export const resolveNotePermission = () => "owner";
        export const sharedNoteBlocksDelete = () => false;
      `,
      "/ui/dropdown-menu": `
        export const DropdownMenu = ({ children }) => children;
        export const DropdownMenuTrigger = ({ children }) => children;
        export const DropdownMenuContent = () => null;
        export const DropdownMenuItem = () => null;
        export const DropdownMenuSub = ({ children }) => children;
        export const DropdownMenuSubTrigger = () => null;
        export const DropdownMenuSubContent = () => null;
        export const DropdownMenuSeparator = () => null;
      `,
      "/ui/dialog": "export const ConfirmDialog = () => null;",
      "/CreateSpaceDialog": "export default function Mock() { return null; }",
      "/DeleteSpaceDialog": "export default function Mock() { return null; }",
      "/SpaceSettingsDialog": "export default function Mock() { return null; }",
      "/stores/deviceNotesStore": `
        const state = {
          ...${JSON.stringify(deviceNotes)},
          load: async () => {},
          startListening: () => () => {},
        };
        export const useDeviceNotesStore = Object.assign((selector) => selector(state), {
          getState: () => state,
        });
      `,
    },
  });
  const { I18nextProvider } = await vite.ssrLoadModule("react-i18next");
  const { default: SpacesTree } = await vite.ssrLoadModule("/components/notes/SpacesTree.tsx");
  return renderToStaticMarkup(
    React.createElement(
      "div",
      { dir: "ltr" },
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
    )
  );
}

test("the pending Private and the workspace's own one show as one section, every note in it", async (t) => {
  const markup = await renderTree(t);
  // Each folder name once: the two Privates' "Plans" are one row.
  assert.equal(markup.match(/>Plans</g)?.length, 1, "folders of one name are one row");
  assert.equal(markup.match(/>Ideas</g)?.length, 1);
  for (const note of NOTES) {
    assert.match(markup, new RegExp(note.title), `${note.title} is reachable from the tree`);
  }
});

test("the section is hidden when there are no device notes", async (t) => {
  const markup = await renderTree(t);
  assert.doesNotMatch(markup, /On this device/);
});

test("the section shows its title, folder rows with counts and root notes", async (t) => {
  const markup = await renderTree(t, {
    folders: [{ id: 7, name: "Old plans", is_default: 0, noteCount: 2 }],
    notes: [
      { id: 70, title: "Device plan", folder_id: 7 },
      { id: 71, title: "Device draft", folder_id: 7 },
      { id: 72, title: "Device loose note", folder_id: null },
      // Its folder was deleted: it sits at the section's root.
      { id: 73, title: "Orphaned device note", folder_id: 99 },
    ],
    viewNoteId: null,
  });
  assert.match(markup, />On this device</);
  assert.match(markup, />Old plans</);
  assert.match(markup, /Old plans, 2 notes/);
  for (const title of [
    "Device plan",
    "Device draft",
    "Device loose note",
    "Orphaned device note",
  ]) {
    assert.match(markup, new RegExp(`>${title}<`));
  }
  const level = (title) => markup.match(new RegExp(`aria-level="(\\d)"[^>]*title="${title}"`))?.[1];
  assert.deepEqual(["Device plan", "Device loose note", "Orphaned device note"].map(level), [
    "2",
    "1",
    "1",
  ]);
});

test("the section is one labelled group, its collapsed folders' notes out of reach", async (t) => {
  const markup = await renderTree(t, {
    folders: [{ id: 7, name: "Old plans", is_default: 0, noteCount: 1 }],
    notes: [
      { id: 70, title: "Device plan", folder_id: 7 },
      { id: 72, title: "Device loose note", folder_id: null },
    ],
    viewNoteId: null,
  });
  const { Window } = await import("happy-dom");
  const page = new Window();
  t.after(() => page.happyDOM.close());
  page.document.body.innerHTML = markup;
  const row = (title) => page.document.querySelector(`[role="treeitem"][title="${title}"]`);
  const group = row("Device loose note").closest('[role="group"]');
  assert.equal(group?.getAttribute("aria-label"), "On this device");
  assert.equal(row("Device plan").closest('[role="group"][aria-label]'), group);
  // Folders start collapsed: their notes sit in an inert wrapper, out of Tab order.
  assert.ok(row("Device plan").closest("[inert]"), "a collapsed folder's notes are inert");
  assert.equal(row("Device loose note").closest("[inert]"), null);
});

test("the section's info button is always visible", async (t) => {
  const markup = await renderTree(t, {
    folders: [],
    notes: [{ id: 72, title: "Device loose note", folder_id: null }],
    viewNoteId: null,
  });
  const button = markup.match(/<button[^>]*aria-label="notes\.deviceNotes\.infoLabel"[^>]*>/)?.[0];
  assert.ok(button, "the info button renders");
  assert.match(button, /opacity-100/);
  assert.doesNotMatch(button, /\bopacity-0\b/);
});

test("a device folder shows its five newest notes, then an N more row", async (t) => {
  const notes = Array.from({ length: 7 }, (_, index) => ({
    id: 80 + index,
    title: `Old note ${index}`,
    folder_id: 7,
    updated_at: new Date(Date.UTC(2026, 7, 20) - index * 60000).toISOString(),
  }));
  const markup = await renderTree(t, {
    folders: [{ id: 7, name: "Old plans", is_default: 0, noteCount: 7 }],
    notes,
    viewNoteId: null,
  });
  const rowTitles = [...markup.matchAll(/role="treeitem"[^>]*title="(Old note \d)"/g)].map(
    (match) => match[1]
  );
  assert.deepEqual(rowTitles, [
    "Old note 0",
    "Old note 1",
    "Old note 2",
    "Old note 3",
    "Old note 4",
  ]);
  assert.match(markup, /aria-label="notes\.folderMore\.more"/);
});
