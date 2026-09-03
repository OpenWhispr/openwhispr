const assert = require("node:assert/strict");
const test = require("node:test");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const i18next = require("i18next");
const { initReactI18next } = require("react-i18next");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const PRIVATE_NOTE_TITLE = "خطة Private 2026";
const TEAM_NOTE_TITLE = "Engineering ملاحظات";

async function renderTree(t, direction) {
  installBrowserGlobals(t);
  const i18n = i18next.createInstance();
  await i18n.use(initReactI18next).init({
    lng: direction === "rtl" ? "ar" : "en",
    fallbackLng: "en",
    resources: { ar: { translation: {} }, en: { translation: {} } },
    initImmediate: false,
    interpolation: { escapeValue: false },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: `openwhispr-spaces-tree-note-clearance-${direction}-`,
    mockModules: {
      "/stores/noteStore": `
        const spaces = [
          { id: 1, kind: "private", name: "Personal", sync_status: "synced" },
          { id: 2, kind: "team", name: "Engineering", sync_status: "synced" },
        ];
        const folders = [
          { id: 11, space_id: 1, name: "Private folder", is_default: 0 },
          { id: 22, space_id: 2, name: "Team folder", is_default: 0 },
        ];
        const notes = [
          { id: 101, space_id: 1, folder_id: 11, title: ${JSON.stringify(PRIVATE_NOTE_TITLE)} },
          { id: 202, space_id: 2, folder_id: 22, title: ${JSON.stringify(TEAM_NOTE_TITLE)} },
        ];
        export const folderContainerKey = (id) => "folder:" + id;
        export const spaceContainerKey = (id) => "space:" + id;
        export const useSpaces = () => spaces;
        export const useFolders = () => folders;
        export const useFolderCounts = () => ({ 11: 1, 22: 1 });
        export const useSpaceRootCounts = () => ({ 1: 0, 2: 0 });
        export const useNotesByContainer = () => ({
          "space:1": [],
          "space:2": [],
          "folder:11": [notes[0]],
          "folder:22": [notes[1]],
        });
        export const useExpandedContainers = () => new Set([
          "space:1", "space:2", "folder:11", "folder:22"
        ]);
        export const useActiveContext = () => null;
        export const useActiveNoteId = () => null;
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
      "/hooks/useWorkspace":
        "export const useWorkspace = () => ({ workspaces: [], loaded: true });",
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
        export const canManageSpace = () => true;
        export const canManageWorkspace = () => true;
        export const canMoveBetweenSpaces = () => true;
        export const canMoveOrDeleteSpaceFolder = () => true;
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
      "/SpaceMembersDialog": "export default function Mock() { return null; }",
    },
  });
  const { I18nextProvider } = await vite.ssrLoadModule("react-i18next");
  const { default: SpacesTree } = await vite.ssrLoadModule("/components/notes/SpacesTree.tsx");
  return renderToStaticMarkup(
    React.createElement(
      "div",
      { dir: direction },
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

function openingTagForTitle(markup, title) {
  const encodedTitle = title.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
  const match = markup.match(new RegExp(`<div[^>]*title="${encodedTitle}"[^>]*>`));
  assert.ok(match, `rendered note row for ${JSON.stringify(title)}`);
  return match[0];
}

for (const direction of ["ltr", "rtl"]) {
  test(`private and team folder note titles clear their actions in ${direction}`, async (t) => {
    const markup = await renderTree(t, direction);

    for (const title of [PRIVATE_NOTE_TITLE, TEAM_NOTE_TITLE]) {
      assert.match(
        openingTagForTitle(markup, title),
        /style="padding-inline-end:27px"/,
        `${title} must reserve the complete logical-end kebab slot`
      );
    }
  });
}
