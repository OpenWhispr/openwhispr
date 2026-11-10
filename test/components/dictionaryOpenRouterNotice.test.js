const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

const IGNORED_NOTICE = "dictionary.openRouterIgnoredNotice";
const LOCAL_NOTICE = "dictionary.localModelIgnoredNotice";
const LIMIT_NOTICE = "dictionary.promptLimitNotice";
const HOTWORDS_NOTICE = "dictionary.localModelHotwordsLimitNotice";
const ORUKEET = {
  useLocalWhisper: true,
  localTranscriptionProvider: "nvidia",
  parakeetModel: "orukeet-v0.1.0",
};
const LONG_DICTIONARY = Array.from({ length: 60 }, (_, i) => `SpecializedTerm${i}`);

function textsOf(node, found = []) {
  if (Array.isArray(node)) {
    for (const child of node) textsOf(child, found);
  } else if (typeof node === "string") {
    found.push(node);
  } else if (node && typeof node === "object") {
    textsOf(node.props?.children, found);
  }
  return found;
}

// Mounts DictionaryView under React's client lifecycle, so the settings and
// enterprise stores update it live; the returned element tree is the boundary.
// Words come from useSettings (stubbed); the dictation route comes from the
// real settings store, exactly as the page reads it.
async function mountDictionary(t) {
  let unmount = async () => {};
  t.after(() => unmount());
  installBrowserGlobals(t, { window: { location: { search: "" }, electronAPI: {} } });
  const container = installHookDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-dictionary-openrouter-notice-",
    resolveAlias: { "@": path.resolve(__dirname, "../../src") },
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `
        const t = (key, options) =>
          key === "${HOTWORDS_NOTICE}" ? [key, options?.model, options?.limit].join("|") : key;
        export function useTranslation() {
          return { t, i18n: { language: "en", dir: () => "ltr" } };
        }
        export const initReactI18next = { type: "3rdParty", init() {} };
      `,
      "/hooks/useSettings": `
        export function useSettings() {
          return {
            customDictionary: globalThis.__dictionaryWords,
            updateCustomDictionary() {},
            snippets: [],
          };
        }
      `,
      "/SnippetsView": "export default function SnippetsView() { return null; }",
      "/ui/useToast": "export function useToast() { return { toast() {} }; }",
      "/utils/agentName": "export function getAgentName() { return 'Nova'; }",
      // Signed out with no shared dictionary, so the page shows Personal alone and
      // starts no account or shared-list requests that outlive the test.
      "/hooks/useAuth": "export function useAuth() { return { isSignedIn: false, user: null }; }",
      "/hooks/useWorkspace": `
        export function useWorkspace() { return { active: null, role: null, workspaces: [] }; }
      `,
      "/stores/sharedDictionaryStore": `
        const state = {
          status: "unavailable",
          snapshot: null,
          movedPersonal: [],
          syncing: false,
          lastSyncedAt: null,
          requestedList: null,
          setRequestedList() {},
          reload: async () => {},
          generation: 0,
          markSynced() {},
        };
        export function useSharedDictionaryStore(selector) { return selector(state); }
        useSharedDictionaryStore.getState = () => state;
      `,
    },
  });
  globalThis.__dictionaryWords = [];
  t.after(() => {
    delete globalThis.__dictionaryWords;
  });
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const { useEnterpriseIdentityStore } = await vite.ssrLoadModule(
    "/stores/enterpriseIdentityStore.ts"
  );
  const { default: DictionaryView } = await vite.ssrLoadModule("/components/DictionaryView.tsx");

  let tree;
  let rerender;
  function Harness() {
    const [, setTick] = React.useState(0);
    rerender = () => setTick((tick) => tick + 1);
    tree = DictionaryView({ onUpgrade() {} });
    return null;
  }
  const root = createRoot(container);
  await React.act(async () => root.render(React.createElement(Harness)));
  unmount = async () => {
    unmount = async () => {};
    await React.act(async () => root.unmount());
  };

  const notices = async (dictation, words = ["Kubernetes"]) => {
    globalThis.__dictionaryWords = words;
    await React.act(async () => {
      useSettingsStore.setState({
        useLocalWhisper: false,
        cloudTranscriptionMode: "byok",
        transcriptionMode: "providers",
        remoteTranscriptionUrl: "",
        cloudTranscriptionBaseUrl: "",
        localTranscriptionProvider: "whisper",
        ...dictation,
      });
      rerender();
    });
    return textsOf(tree).filter(
      (text) =>
        [IGNORED_NOTICE, LOCAL_NOTICE, LIMIT_NOTICE].includes(text) ||
        text.startsWith(HOTWORDS_NOTICE)
    );
  };
  const setEnterprise = (state) =>
    React.act(async () => useEnterpriseIdentityStore.setState(state));
  return { notices, setEnterprise };
}

const OPENROUTER_TAB = {
  cloudTranscriptionProvider: "openrouter",
  cloudTranscriptionModel: "openai/gpt-transcribe",
};
const OPENAI = { cloudTranscriptionProvider: "openai", cloudTranscriptionModel: "whisper-1" };

test("the Dictionary says when OpenRouter won't pass its words on", async (t) => {
  const { notices, setEnterprise } = await mountDictionary(t);

  assert.deepEqual(await notices(OPENROUTER_TAB), [IGNORED_NOTICE], "OpenRouter tab");
  assert.deepEqual(
    await notices({
      cloudTranscriptionProvider: "custom",
      cloudTranscriptionBaseUrl: "https://openrouter.ai/api/v1",
      cloudTranscriptionModel: "openai/gpt-transcribe",
    }),
    [IGNORED_NOTICE],
    "Custom endpoint on OpenRouter"
  );

  assert.deepEqual(await notices(OPENAI), [], "OpenAI reads the dictionary");
  assert.deepEqual(
    await notices({ ...OPENROUTER_TAB, cloudTranscriptionMode: "openwhispr" }),
    [],
    "OpenWhispr Cloud"
  );
  assert.deepEqual(await notices({ ...OPENROUTER_TAB, useLocalWhisper: true }), [], "local model");

  // The length warning still guides Whisper-style models, but its "other models
  // get the full list" claim is false while OpenRouter drops the list.
  assert.deepEqual(await notices(OPENAI, LONG_DICTIONARY), [LIMIT_NOTICE]);
  assert.deepEqual(await notices(OPENROUTER_TAB, LONG_DICTIONARY), [IGNORED_NOTICE]);

  // A managed workspace transcribes with its own deployment, whatever the
  // personal settings still say (fixture shape: dictationTranslationInference.test.js).
  await setEnterprise({
    status: "ready",
    config: {
      workspaceId: "workspace-a",
      version: 1,
      providers: [
        {
          provider: "azure",
          mode: "managed_required",
          allowManualSetup: false,
          config: { transcription: { defaultDeployment: "stt" } },
          version: 1,
          updatedAt: "2026-09-25T00:00:00.000Z",
        },
      ],
    },
  });
  t.after(() => setEnterprise({ status: "idle", config: null }));
  assert.deepEqual(await notices(OPENROUTER_TAB), [], "managed workspace");
  assert.deepEqual(await notices(ORUKEET), [], "managed workspace with Orukeet selected locally");
});

test("the Dictionary says when the local model can't use its words", async (t) => {
  const { notices } = await mountDictionary(t);
  const parakeet = (parakeetModel) => ({
    useLocalWhisper: true,
    localTranscriptionProvider: "nvidia",
    parakeetModel,
  });

  assert.deepEqual(
    await notices({
      useLocalWhisper: true,
      localTranscriptionProvider: "cohere",
      cohereModel: "cohere-transcribe-03-2026",
    }),
    [LOCAL_NOTICE],
    "Cohere Transcribe"
  );
  assert.deepEqual(await notices(parakeet("parakeet-tdt-0.6b-v3")), [LOCAL_NOTICE], "Parakeet");
  assert.deepEqual(
    await notices(parakeet("nemotron-speech-streaming-en-0.6b")),
    [LOCAL_NOTICE],
    "Nemotron"
  );
  assert.deepEqual(await notices({ useLocalWhisper: true }), [], "local Whisper takes a prompt");
  assert.deepEqual(
    await notices({ ...parakeet("parakeet-tdt-0.6b-v3"), useLocalWhisper: false, ...OPENAI }),
    [],
    "cloud dictation"
  );
});

test("the Dictionary shows Orukeet's hotword limit for local dictation", async (t) => {
  const { notices } = await mountDictionary(t);
  const expectedNotice = [`${HOTWORDS_NOTICE}|Orukeet|100`];
  const overLimitDictionary = Array.from({ length: 101 }, (_, i) => `Term${i}`);

  assert.deepEqual(await notices(ORUKEET), expectedNotice, "short dictionary");
  assert.deepEqual(await notices(ORUKEET, overLimitDictionary), expectedNotice, "over the limit");
  assert.deepEqual(
    await notices({ ...ORUKEET, useLocalWhisper: false, ...OPENAI }, overLimitDictionary),
    [LIMIT_NOTICE],
    "cloud dictation with Orukeet selected locally"
  );
});
