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

async function renderTree(t) {
  installBrowserGlobals(t);
  const i18n = i18next.createInstance();
  await i18n.use(initReactI18next).init({
    lng: "en",
    fallbackLng: "en",
    resources: { en: { translation: {} } },
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
