const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHostDom,
} = require("../lib/rendererTestHarness");

async function setup(t) {
  let root;
  t.after(async () => {
    await React.act(async () => root?.unmount());
    delete globalThis.__enterpriseUpload;
  });
  const listeners = new Set();
  const fixture = {
    buttons: [],
    calls: [],
    pending: [],
    selection: ["/tmp/hour.wav"],
    size: 115 * 1024 * 1024,
    usage: { hasPaidAccessOptimistic: false },
  };
  globalThis.__enterpriseUpload = fixture;
  installBrowserGlobals(t, {
    initialStorage: { _providerSettingsMigrated: "1", uploadTranscriptionMigrated: "true" },
    window: {
      electronAPI: {
        selectAudioFile: async () => ({ filePaths: fixture.selection }),
        getFileSize: async () => fixture.size,
        getSpaces: async () => [],
        getFolders: async () => [],
        getDiarizationModelStatus: async () => ({ modelsDownloaded: false }),
        onUploadTranscriptionProgress: (callback) => {
          listeners.add(callback);
          return () => listeners.delete(callback);
        },
        cancelUploadTranscription() {},
        cancelUrlDownload() {},
      },
    },
  });
  const container = installHostDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-enterprise-upload-ui-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `const t=(key, options)=>key+(options ? JSON.stringify(options) : ""); export const useTranslation=()=>({t}); export const initReactI18next={type:"3rdParty",init(){}};`,
      "/hooks/useAuth": "export const useAuth=()=>({isSignedIn:true});",
      "/hooks/useUsage": "export const useUsage=()=>globalThis.__enterpriseUpload.usage;",
      "/hooks/useSettings":
        "import {useSettingsStore} from '/stores/settingsStore.ts'; export const useSettings=()=>useSettingsStore();",
      "/ui/button": `import React from 'react'; export function Button(props){globalThis.__enterpriseUpload.buttons.push(props); const {children,variant,size,...rest}=props; return React.createElement('button',rest,children);}`,
      "/ui/dialog":
        "export const Dialog=()=>null; export const DialogContent=()=>null; export const DialogHeader=()=>null; export const DialogTitle=()=>null; export const DialogFooter=()=>null;",
      "/services/fileTranscription": `
        export const getTranscriptionApiKey=(_provider, keys)=>keys.openaiApiKey;
        export const shouldUseByokDiarize=()=>false;
        export const resolveDiarizationSettings=async()=>({enabled:false,localModelsReady:false,numSpeakers:null});
        export function transcribeFileWithSpeakers(...args){ const f=globalThis.__enterpriseUpload; f.calls.push(args); return new Promise(resolve=>f.pending.push(resolve)); }
      `,
      "/services/uploadNotes":
        "export const saveUploadNote=async()=>({success:true,note:{id:42}}); export const uploadTitleFallback=()=> 'Uploaded note';",
      "/utils/generateTitle": "export const generateNoteTitle=async()=>'';",
      "/utils/logger": "export default {warn(){},error(){},info(){},debug(){}};",
    },
  });
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  const { useEnterpriseIdentityStore } = await vite.ssrLoadModule(
    "/stores/enterpriseIdentityStore.ts"
  );
  const queue = await vite.ssrLoadModule("/stores/batchQueueStore.ts");
  const { default: UploadAudioView } = await vite.ssrLoadModule(
    "/components/notes/UploadAudioView.tsx"
  );
  usePolicyStore.setState({ status: "unmanaged", accountId: "account-a", authGeneration: 1 });
  useSettingsStore.setState({
    isSignedIn: true,
    useCleanupModel: false,
    autoGenerateNoteTitle: false,
    openaiApiKey: "personal-key",
    enterpriseTranscriptionSetupMode: "managed",
  });
  useEnterpriseIdentityStore.setState({
    status: "ready",
    accountId: "account-a",
    workspaceId: "workspace-a",
    authGeneration: 1,
    config: {
      generation: 1,
      providers: [
        {
          provider: "openai-compatible",
          mode: "managed_required",
          allowManualSetup: false,
          version: 1,
          config: { batch: { defaultDeployment: "company-batch" } },
        },
      ],
    },
  });
  root = createRoot(container);
  const render = async (mode = "enterprise") => {
    await React.act(async () => {
      queue.clearBatchQueue();
      useSettingsStore.setState({
        uploadTranscriptionMode: mode,
        uploadUseLocalWhisper: mode === "local",
        uploadCloudTranscriptionMode: mode === "openwhispr" ? "openwhispr" : "byok",
        uploadCloudTranscriptionProvider: "openai",
        uploadCloudTranscriptionModel: "personal-model",
      });
      root.render(React.createElement(UploadAudioView, { key: mode }));
    });
  };
  const click = (key) => {
    if (key === "notes.upload.browseFiles") {
      const nodes = [container];
      while (nodes.length) {
        const node = nodes.pop();
        if (node.getAttribute?.("aria-label") === "notes.upload.dropOrBrowse")
          return node[Object.keys(node).find((name) => name.startsWith("__reactProps$"))].onClick();
        nodes.push(...node.childNodes);
      }
      assert.fail("Missing file picker");
    }
    const button = fixture.buttons.findLast((props) => props.children === key);
    assert.ok(button, `Missing button ${key}`);
    assert.equal(!!button.disabled, false);
    return button.onClick();
  };
  const emitProgress = (chunksCompleted, chunksTotal) =>
    React.act(async () => {
      for (const callback of listeners)
        callback({ stage: "transcribing", chunksCompleted, chunksTotal });
    });
  const finish = async (pending) =>
    React.act(async () => {
      fixture.pending.shift()({ success: true, text: "Enterprise transcript" });
      await pending;
      await new Promise(setImmediate);
    });
  return {
    fixture,
    listeners,
    container,
    render,
    click,
    emitProgress,
    finish,
    useEnterpriseIdentityStore,
    usePolicyStore,
    queue,
  };
}

test("managed upload UI accepts large files, names the actual route and consumes chunk progress despite personal preferences", async (t) => {
  const f = await setup(t);
  for (const mode of ["enterprise", "openwhispr", "local"]) {
    f.fixture.size = mode === "openwhispr" ? 600 * 1024 * 1024 : 115 * 1024 * 1024;
    await f.render(mode);
    await React.act(async () => f.click("notes.upload.browseFiles"));
    assert.match(f.container.textContent, /OpenAI-compatible · company-batch/);
    assert.doesNotMatch(
      f.container.textContent,
      /byokTooLarge|paidPlanRequired|fileTooLarge|Whisper|personal-model/
    );
    let pending;
    await React.act(async () => {
      pending = f.click("notes.upload.transcribe");
    });
    assert.equal(f.listeners.size, 1);
    await f.emitProgress(2, 4);
    assert.match(f.container.textContent, /chunkProgress.*"completed":2,"total":4/);
    assert.match(f.container.textContent, /transcribingProvider.*OpenAI-compatible/);
    await f.finish(pending);
    assert.equal(f.listeners.size, 0);
  }
  assert.equal(f.fixture.calls.length, 3);
});

test("personal upload limits and feature restrictions remain while managed queues receive progress and clean up on cancel", async (t) => {
  const f = await setup(t);
  await React.act(async () => f.useEnterpriseIdentityStore.setState({ config: null }));
  await f.render("providers");
  await React.act(async () => f.click("notes.upload.browseFiles"));
  assert.match(f.container.textContent, /byokTooLarge/);
  await f.render("openwhispr");
  await React.act(async () => f.click("notes.upload.browseFiles"));
  assert.match(f.container.textContent, /paidPlanRequired/);
  await React.act(async () =>
    f.useEnterpriseIdentityStore.setState({
      config: {
        generation: 2,
        providers: [
          {
            provider: "openai-compatible",
            mode: "managed_required",
            allowManualSetup: false,
            version: 2,
            config: { batch: { defaultDeployment: "company-batch" } },
          },
        ],
      },
    })
  );
  f.fixture.selection = ["/tmp/first.wav", "/tmp/second.wav"];
  await f.render("enterprise");
  await React.act(async () => f.click("notes.upload.browseFiles"));
  await React.act(async () => f.click("notes.upload.transcribe"));
  assert.equal(f.fixture.calls.length, 1);
  await f.emitProgress(1, 4);
  assert.equal(f.queue.useBatchQueueStore.getState().queue[0].progress, 22.5);
  await f.finish();
  assert.equal(f.fixture.calls.length, 2);
  assert.equal(f.listeners.size, 1);
  await f.emitProgress(2, 4);
  assert.equal(f.queue.useBatchQueueStore.getState().queue[1].progress, 45);
  await React.act(async () =>
    f.usePolicyStore.setState({
      status: "managed",
      policy: {
        transcription: {
          allowedModes: ["enterprise"],
          allowedByokProviders: [],
          allowedEnterpriseProviders: ["openai-compatible"],
        },
        llm: { allowedModes: ["openwhispr"], allowedByokProviders: [] },
        features: { audioUploadEnabled: false },
      },
    })
  );
  assert.equal(f.queue.useBatchQueueStore.getState().isProcessing, false);
  assert.equal(f.listeners.size, 0);
  await f.finish();
  assert.equal(f.queue.useBatchQueueStore.getState().queue[1].status, "error");
});
