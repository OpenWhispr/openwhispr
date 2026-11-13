const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHostDom,
} = require("../lib/rendererTestHarness");

// The upload view lists the active workspace's Private folders. Main answers getPrivateSpaceId()
// with the Private of the workspace it last heard; a switch is heard as a published scope.
test("the upload folder list follows the active workspace's Private", async (t) => {
  let root;
  t.after(async () => {
    await React.act(async () => root?.unmount());
  });
  const state = { privateSpaceId: 1, folderReads: [] };
  const FOLDERS = {
    1: [{ id: 10, space_id: 1, name: "Personal", is_default: 1 }],
    4: [{ id: 40, space_id: 4, name: "Personal", is_default: 1 }],
  };
  installBrowserGlobals(t, {
    initialStorage: { _providerSettingsMigrated: "1", uploadTranscriptionMigrated: "true" },
    window: {
      // Upload audio lives in the control panel, the window that publishes the workspace scope.
      location: { search: "?panel=true" },
      electronAPI: {
        getPrivateSpaceId: async () => state.privateSpaceId,
        getFolders: async (spaceId) => {
          state.folderReads.push(spaceId);
          return FOLDERS[spaceId] ?? [];
        },
        setActiveWorkspaceScope: async () => ({ success: true }),
        getDiarizationModelStatus: async () => ({ modelsDownloaded: false }),
        onUploadTranscriptionProgress: () => () => {},
        cancelUploadTranscription() {},
        cancelUrlDownload() {},
      },
    },
  });
  const container = installHostDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-upload-private-folders-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `const t=(key)=>key; export const useTranslation=()=>({t}); export const initReactI18next={type:"3rdParty",init(){}};`,
      "/hooks/useAuth": "export const useAuth=()=>({isSignedIn:true});",
      "/hooks/useUsage": "export const useUsage=()=>({ hasPaidAccessOptimistic: false });",
      "/hooks/useSettings":
        "import {useSettingsStore} from '/stores/settingsStore.ts'; export const useSettings=()=>useSettingsStore();",
      "/ui/dialog":
        "export const Dialog=()=>null; export const DialogContent=()=>null; export const DialogHeader=()=>null; export const DialogTitle=()=>null; export const DialogFooter=()=>null;",
      "/utils/logger": "export default {warn(){},error(){},info(){},debug(){}};",
      // The real transcription services keep the process alive after the test; none runs here.
      "/services/fileTranscription":
        "export const getTranscriptionApiKey=()=>null; export const shouldUseByokDiarize=()=>false; export const resolveDiarizationSettings=async()=>({enabled:false,localModelsReady:false,numSpeakers:null}); export const transcribeFileWithSpeakers=()=>new Promise(()=>{});",
      "/services/uploadNotes":
        "export const saveUploadNote=async()=>({success:true,note:{id:42}}); export const uploadTitleFallback=()=>'x';",
      "/utils/generateTitle": "export const generateNoteTitle=async()=>'';",
    },
  });
  const { publishWorkspaceScope } = await vite.ssrLoadModule("/stores/workspaceStore.ts");
  const { default: UploadAudioView } = await vite.ssrLoadModule(
    "/components/notes/UploadAudioView.tsx"
  );
  const settle = () => React.act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(UploadAudioView)));
  await settle();
  assert.deepEqual(state.folderReads, [1]);

  // The user switches workspace; main hears it and answers with that workspace's Private.
  state.privateSpaceId = 4;
  await React.act(async () => {
    await publishWorkspaceScope();
  });
  await settle();
  assert.deepEqual(state.folderReads, [1, 4]);
});

// M10: once a note is saved, the picker files that note, so it stays on the note's own space. A
// workspace switch afterwards must not offer the new workspace's Private folders, where picking
// one would move the note across workspaces.
test("after a switch, the saved upload's folder picker stays on the note's own Private", async (t) => {
  let root;
  t.after(async () => {
    await React.act(async () => root?.unmount());
  });
  const state = { privateSpaceId: 1, folderReads: [], updates: [] };
  const FOLDERS = {
    1: [
      { id: 10, space_id: 1, name: "Personal", is_default: 1 },
      { id: 11, space_id: 1, name: "Ideas", is_default: 0 },
    ],
    4: [{ id: 40, space_id: 4, name: "Personal", is_default: 1 }],
  };
  globalThis.__uploadDropZone = null;
  installBrowserGlobals(t, {
    initialStorage: { _providerSettingsMigrated: "1", uploadTranscriptionMigrated: "true" },
    window: {
      // Upload audio lives in the control panel, the window that publishes the workspace scope.
      location: { search: "?panel=true" },
      electronAPI: {
        getPrivateSpaceId: async () => state.privateSpaceId,
        getFolders: async (spaceId) => {
          state.folderReads.push(spaceId);
          return FOLDERS[spaceId] ?? [];
        },
        updateNote: async (id, updates) => {
          state.updates.push([id, updates]);
          return { success: true };
        },
        getPathForFile: (file) => `/tmp/${file.name}`,
        setActiveWorkspaceScope: async () => ({ success: true }),
        getDiarizationModelStatus: async () => ({ modelsDownloaded: false }),
        onUploadTranscriptionProgress: () => () => {},
        cancelUploadTranscription() {},
        cancelUrlDownload() {},
        deleteTempFile() {},
      },
    },
  });
  const container = installHostDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-upload-private-folders-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `const t=(key)=>key; export const useTranslation=()=>({t}); export const initReactI18next={type:"3rdParty",init(){}};`,
      "/hooks/useAuth": "export const useAuth=()=>({isSignedIn:true});",
      "/hooks/useUsage": "export const useUsage=()=>({ hasPaidAccessOptimistic: false });",
      "/hooks/useSettings":
        "import {useSettingsStore} from '/stores/settingsStore.ts'; export const useSettings=()=>useSettingsStore();",
      "/ui/dialog":
        "export const Dialog=()=>null; export const DialogContent=()=>null; export const DialogHeader=()=>null; export const DialogTitle=()=>null; export const DialogFooter=()=>null;",
      "/ui/DropZone":
        "export const DropZone=(props)=>{ globalThis.__uploadDropZone=props; return null; };",
      // The folder picker: the values it offers and its change handler.
      "/ui/select": `
        import React from "react";
        const Pass = ({ children }) => React.createElement("div", null, children);
        export const Select = ({ onValueChange, children }) => {
          globalThis.__uploadFolderSelect = onValueChange;
          return Pass({ children });
        };
        export const SelectTrigger = Pass;
        export const SelectContent = Pass;
        export const SelectValue = () => null;
        export const SelectSeparator = () => null;
        export const SelectItem = ({ value, children }) =>
          React.createElement("span", { "data-folder": value }, children);
      `,
      "/utils/logger": "export default {warn(){},error(){},info(){},debug(){}};",
      "/services/fileTranscription":
        "export const getTranscriptionApiKey=()=>null; export const shouldUseByokDiarize=()=>false; export const resolveDiarizationSettings=async()=>({enabled:false,localModelsReady:false,numSpeakers:null}); export const transcribeFileWithSpeakers=async()=>({success:true,text:'Hello there'});",
      "/services/uploadNotes":
        "export const saveUploadNote=async({folderId})=>({success:true,note:{id:42,space_id:1,folder_id:folderId}}); export const uploadTitleFallback=()=>'x';",
      "/utils/generateTitle": "export const generateNoteTitle=async()=>'';",
    },
  });
  const { publishWorkspaceScope } = await vite.ssrLoadModule("/stores/workspaceStore.ts");
  const { default: UploadAudioView } = await vite.ssrLoadModule(
    "/components/notes/UploadAudioView.tsx"
  );
  const settle = () => React.act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  const findButton = (node, text) => {
    if (node.nodeName === "BUTTON" && textOfNode(node).includes(text)) return node;
    for (const child of node.childNodes ?? []) {
      const found = findButton(child, text);
      if (found) return found;
    }
    return null;
  };
  const propsOf = (node) => node[Object.keys(node).find((key) => key.startsWith("__reactProps$"))];

  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(UploadAudioView)));
  await settle();
  await React.act(async () =>
    globalThis.__uploadDropZone.onFiles([{ name: "call.mp3", size: 1000 }])
  );
  await settle();
  const transcribe = findButton(container, "notes.upload.transcribe");
  assert.ok(transcribe, "the selected file offers Transcribe");
  await React.act(async () => propsOf(transcribe).onClick());
  for (let i = 0; i < 5; i++) await settle();
  assert.deepEqual(state.folderReads, [1]);

  // The user switches workspace; main now answers that workspace's Private.
  state.privateSpaceId = 4;
  await React.act(async () => {
    await publishWorkspaceScope();
  });
  await settle();
  assert.ok(!state.folderReads.includes(4), "the picker never lists the new workspace's folders");
  assert.ok(offeredFolders(container).includes("11"), "the note's own folders stay on offer");
  assert.ok(!offeredFolders(container).includes("40"));

  // Picking from it keeps the note in its own Private.
  await React.act(async () => globalThis.__uploadFolderSelect("11"));
  assert.deepEqual(state.updates, [[42, { folder_id: 11 }]]);
});

function offeredFolders(node, found = []) {
  if (node.attributes?.["data-folder"] != null) found.push(String(node.attributes["data-folder"]));
  for (const child of node.childNodes ?? []) offeredFolders(child, found);
  return found;
}

function textOfNode(node) {
  if (node.nodeType === 3) return node.nodeValue;
  return [...(node.childNodes ?? [])].map(textOfNode).join("");
}
