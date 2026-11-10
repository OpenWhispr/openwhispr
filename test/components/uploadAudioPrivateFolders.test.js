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
