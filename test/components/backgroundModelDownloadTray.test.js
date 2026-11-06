const assert = require("node:assert/strict");
const test = require("node:test");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

const LLM = "qwen3.5-4b-q4_k_m";
const PARAKEET = "parakeet-tdt-0.6b-v3";
const SESSION_KEY = "onboardingSessionV2";

function findElement(node, predicate) {
  if (Array.isArray(node)) {
    for (const child of node) {
      const match = findElement(child, predicate);
      if (match) return match;
    }
    return null;
  }
  if (!node || typeof node !== "object") return null;
  return predicate(node) ? node : findElement(node.props?.children, predicate);
}

function textContent(node) {
  if (Array.isArray(node)) return node.map(textContent).join("");
  if (node && typeof node === "object") return textContent(node.props?.children);
  return node == null || typeof node === "boolean" ? "" : String(node);
}

function saveSession(currentStepId) {
  localStorage.setItem(
    SESSION_KEY,
    JSON.stringify({
      version: 2,
      currentStepId,
      history: [],
      authPath: "account",
      setupMode: "local",
    })
  );
}

async function createTrayHarness(t, { api = {}, storage = {}, beforeMount } = {}) {
  let unmount = async () => {};
  t.after(() => unmount());
  const listeners = { whisper: new Set(), parakeet: new Set(), llm: new Set() };
  const subscribe = (family) => (listener) => {
    listeners[family].add(listener);
    return () => listeners[family].delete(listener);
  };
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        getPlatform: () => "linux",
        onWhisperDownloadProgress: subscribe("whisper"),
        onParakeetDownloadProgress: subscribe("parakeet"),
        onModelDownloadProgress: subscribe("llm"),
        ...api,
      },
    },
  });
  for (const [key, value] of Object.entries(storage)) localStorage.setItem(key, value);
  const container = installHookDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-download-tray-test-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `
        const t = (key) => key;
        export function useTranslation() { return { t }; }
        export const initReactI18next = { type: "3rdParty", init() {} };
      `,
      "/OnboardingShell": `export function BrandMark() { return null; }`,
      "/ui/ProviderIcon": `export function ProviderIcon() { return null; }`,
    },
  });
  const { default: BackgroundModelDownloadTray } = await vite.ssrLoadModule(
    "/components/onboarding/BackgroundModelDownloadTray.tsx"
  );
  const registry = await vite.ssrLoadModule("/components/onboarding/localSetupDownloadClaims.ts");
  await beforeMount?.({ vite, registry });
  let tree;
  function Harness() {
    tree = BackgroundModelDownloadTray({ placement: "onboarding" });
    return null;
  }
  const root = createRoot(container);
  await React.act(async () => root.render(React.createElement(Harness)));
  unmount = async () => {
    await React.act(async () => root.unmount());
  };

  const emit = async (family, event) => {
    await React.act(async () => {
      for (const listener of listeners[family]) listener({}, event);
    });
  };
  return {
    vite,
    registry,
    emit,
    llm: (modelId, type, progress = 0) => emit("llm", { modelId, type, progress }),
    parakeet: (model, type, percentage = 0) => emit("parakeet", { model, type, percentage }),
    row: (key) => findElement(tree, (node) => node.type === "div" && node.key === key),
    header: () => {
      const header = findElement(
        tree,
        (node) => node.type === "div" && String(node.props?.className).includes("gap-[5px]")
      );
      assert.ok(header, "tray header is visible");
      return textContent(header);
    },
  };
}

test("the tray shows a transfer onboarding does not own", async (t) => {
  const tray = await createTrayHarness(t);
  saveSession("notes");
  await tray.parakeet(PARAKEET, "progress", 40);
  assert.match(textContent(tray.row(`parakeet:${PARAKEET}`)), /40%/);
});

test("tray ignores local-setup downloads", async (t) => {
  const tray = await createTrayHarness(t);

  // On the step: its own rows show the progress, so the tray stays out.
  saveSession("local-setup");
  await tray.llm(LLM, "progress", 10);
  await tray.parakeet(PARAKEET, "installing", 100);
  assert.equal(tray.row(`llm:${LLM}`), null);
  assert.equal(tray.row(`parakeet:${PARAKEET}`), null);

  // Back: the session has already left the step when the cancelled transfer's
  // queued chunks arrive, and a cancel sends no final event. The claim the
  // step's queue took on the item is what keeps those chunks out.
  tray.registry.claimLocalSetupDownload({ kind: "llm", id: LLM });
  tray.registry.releaseLocalSetupDownload({ kind: "llm", id: LLM });
  saveSession("setup-choice");
  await tray.llm(LLM, "progress", 20);
  await tray.llm(LLM, "error");
  assert.equal(tray.row(`llm:${LLM}`), null);

  // Anything the step never claimed still reaches the tray.
  await tray.parakeet(PARAKEET, "progress", 30);
  assert.match(textContent(tray.row(`parakeet:${PARAKEET}`)), /30%/);
});

test("a transfer handed over at Proceed reaches the tray at once, an early error included", async (t) => {
  const tray = await createTrayHarness(t);
  saveSession("notes");
  tray.registry.claimLocalSetupDownload({ kind: "llm", id: LLM });
  await tray.llm(LLM, "progress", 10);
  assert.equal(tray.row(`llm:${LLM}`), null, "the step still owns it");

  tray.registry.handOverLocalSetupDownload({ kind: "llm", id: LLM });
  await tray.emit("llm", { modelId: LLM, type: "error", error: "offline" });
  assert.ok(tray.row(`llm:${LLM}`), "the failure shows, with no grace period to swallow it");
});

test("a completion still reaches the tray on the local-setup step", async (t) => {
  const tray = await createTrayHarness(t);
  saveSession("notes");
  await tray.parakeet(PARAKEET, "progress", 50);
  assert.ok(tray.row(`parakeet:${PARAKEET}`));

  saveSession("local-setup");
  await tray.parakeet(PARAKEET, "complete", 100);
  assert.equal(tray.row(`parakeet:${PARAKEET}`), null);
});

test("the tray header follows the transfer into its installing phase", async (t) => {
  const tray = await createTrayHarness(t);
  await tray.parakeet(PARAKEET, "progress", 100);
  assert.equal(tray.header(), "onboarding.rehaul.local.downloadInProgress");

  // Extraction reports no further bytes, so the header is the only thing left
  // that can tell a full bar apart from a stalled one.
  await tray.parakeet(PARAKEET, "installing", 100);
  assert.equal(tray.header(), "onboarding.rehaul.local.installing");
});

test("an extracting row says so while another model is still downloading", async (t) => {
  const tray = await createTrayHarness(t);
  await tray.llm(LLM, "progress", 40);
  await tray.parakeet(PARAKEET, "installing", 100);

  assert.match(
    textContent(tray.row(`parakeet:${PARAKEET}`)),
    /onboarding\.rehaul\.local\.installing/
  );
  assert.match(textContent(tray.row(`llm:${LLM}`)), /40%/);
  // Not every row has reached extraction, so the strip stays on downloading.
  assert.equal(tray.header(), "onboarding.rehaul.local.downloadInProgress");
});

test("a model local setup left downloading turns its row on when it lands", async (t) => {
  const tray = await createTrayHarness(t);
  const store = await tray.vite.ssrLoadModule("/stores/settingsStore.ts");
  const pending = await tray.vite.ssrLoadModule("/components/onboarding/pendingLocalModels.ts");
  saveSession("notes");
  for (const scope of ["dictationAgent", "chatIntelligence"]) {
    store.setResolvedLLMConfig(scope, { mode: "local", provider: "", model: "" });
  }
  pending.rememberPendingLocalModel("assistant", { provider: "qwen", modelId: LLM });

  await tray.llm(LLM, "progress", 50);
  assert.ok(tray.row(`llm:${LLM}`), "the tray shows the background download");
  await tray.llm(LLM, "complete", 100);

  const state = store.useSettingsStore.getState();
  assert.equal(store.selectResolvedLLMConfig(state, "chatIntelligence").model, LLM);
  assert.equal(state.useDictationAgent, true);
  assert.equal(pending.hasPendingLocalModels(), false);
});

// Local setup quit (or reloaded) with its queue still going: main has no transfer
// for the queued row, so the tray finds it missing on the next launch.
// What Proceed writes for rows still downloading: on this device, with no model.
const SCOPES_WAITING = {
  cleanupMode: "local",
  noteFormattingMode: "local",
  translationMode: "local",
  dictationAgentMode: "local",
  chatAgentMode: "local",
};

async function relaunchWithPending(
  t,
  selections,
  { downloaded = [], storage = {}, modelDownload, api = {}, beforeMount } = {}
) {
  const requested = [];
  const tray = await createTrayHarness(t, {
    beforeMount,
    storage: {
      ...SCOPES_WAITING,
      pendingLocalModelSelectionsV1: JSON.stringify(selections),
      localSetupPending: "true",
      ...storage,
    },
    api: {
      ...api,
      listWhisperModels: async () => ({ models: [] }),
      listParakeetModels: async () => ({ models: [] }),
      modelGetAll: async () =>
        [LLM, CLEANUP_LLM].map((id) => ({
          id,
          isDownloaded: downloaded.includes(id),
          isDownloading: false,
        })),
      modelDownload: async (id) => {
        requested.push(id);
        return modelDownload ? modelDownload(id) : { success: true };
      },
    },
  });
  await React.act(async () => {});
  const pending = await tray.vite.ssrLoadModule("/components/onboarding/pendingLocalModels.ts");
  return { tray, requested, pending };
}

const CLEANUP_LLM = "qwen3.5-2b-q4_k_m";

test("after a quit, local setup's queued rows download again, one after another", async (t) => {
  const { requested, pending } = await relaunchWithPending(t, {
    cleanup: { provider: "qwen", modelId: CLEANUP_LLM, resumable: true },
    assistant: { provider: "qwen", modelId: LLM, resumable: true },
  });
  assert.deepEqual(requested, [CLEANUP_LLM, LLM]);
  assert.deepEqual(Object.keys(pending.readPendingLocalModels()), ["cleanup", "assistant"]);
});

test("an older build's missing pick is forgotten, not downloaded", async (t) => {
  const { requested, pending } = await relaunchWithPending(t, {
    assistant: { provider: "qwen", modelId: LLM },
  });
  assert.deepEqual(requested, []);
  assert.equal(pending.hasPendingLocalModels(), false);
});

test("a queued row that finished before the quit turns on instead of downloading", async (t) => {
  const { tray, requested, pending } = await relaunchWithPending(
    t,
    { assistant: { provider: "qwen", modelId: LLM, resumable: true } },
    { downloaded: [LLM] }
  );
  assert.deepEqual(requested, []);
  assert.equal(pending.hasPendingLocalModels(), false);
  const store = await tray.vite.ssrLoadModule("/stores/settingsStore.ts");
  assert.equal(store.useSettingsStore.getState().useDictationAgent, true);
});

test("a queued row Settings has since answered doesn't download again", async (t) => {
  const { requested, pending } = await relaunchWithPending(
    t,
    { assistant: { provider: "qwen", modelId: LLM, resumable: true } },
    {
      downloaded: [CLEANUP_LLM],
      storage: {
        chatAgentProvider: "qwen",
        chatAgentModel: CLEANUP_LLM,
        dictationAgentProvider: "qwen",
        dictationAgentModel: CLEANUP_LLM,
      },
    }
  );
  assert.deepEqual(requested, []);
  assert.equal(pending.hasPendingLocalModels(), false, "nothing waits for it any more");
});

test("a row with one scope still waiting keeps its download", async (t) => {
  const { requested } = await relaunchWithPending(
    t,
    { assistant: { provider: "qwen", modelId: LLM, resumable: true } },
    { storage: { chatAgentMode: "openwhispr" } }
  );
  assert.deepEqual(requested, [LLM], "the Voice Assistant scope still waits");
});

test("a download that kept failing waits for Retry, which starts the count over", async (t) => {
  const { tray, requested, pending } = await relaunchWithPending(t, {
    cleanup: {
      provider: "qwen",
      modelId: CLEANUP_LLM,
      resumable: true,
      failedAttempts: 3,
    },
  });
  assert.deepEqual(requested, [], "no retry on this launch");
  const row = () => tray.row(`llm:${CLEANUP_LLM}`);
  assert.match(textContent(row()), /line\.failed/);
  assert.match(textContent(row()), /foot\.failedStaysOff/, "says the feature stays off");

  const retry = findElement(
    row(),
    (node) => node.props?.children === "onboarding.rehaul.localSetup.retry"
  );
  assert.ok(retry, "a Retry on the row");
  await React.act(async () => retry.props.onClick());
  assert.deepEqual(requested, [CLEANUP_LLM]);
  assert.equal(pending.readPendingLocalModels().cleanup.failedAttempts, undefined);
});

test("a background failure counts toward the limit", async (t) => {
  const { pending } = await relaunchWithPending(
    t,
    { cleanup: { provider: "qwen", modelId: CLEANUP_LLM, resumable: true } },
    { modelDownload: () => ({ success: false, error: "offline" }) }
  );
  assert.equal(pending.readPendingLocalModels().cleanup.failedAttempts, 1);
});

test("a graphics pack still on its way at the quit is fetched on the next launch", async (t) => {
  const packRequests = [];
  const { pending } = await relaunchWithPending(
    t,
    {},
    {
      storage: { pendingLocalGraphicsPackFailures: "0" },
      api: {
        getLlamaVulkanStatus: async () => ({ downloaded: false }),
        downloadLlamaVulkanBinary: async () => {
          packRequests.push("pack");
          return { success: true };
        },
      },
    }
  );
  assert.deepEqual(packRequests, ["pack"]);
  assert.equal(pending.hasPendingGraphicsPack(), false);
});

test("a graphics pack that landed before the quit isn't fetched again", async (t) => {
  const packRequests = [];
  const { pending } = await relaunchWithPending(
    t,
    {},
    {
      storage: { pendingLocalGraphicsPackFailures: "0" },
      api: {
        getLlamaVulkanStatus: async () => ({ downloaded: true }),
        downloadLlamaVulkanBinary: async () => {
          packRequests.push("pack");
          return { success: true };
        },
      },
    }
  );
  assert.deepEqual(packRequests, []);
  assert.equal(pending.hasPendingGraphicsPack(), false);
});

test("right after Proceed the tray leaves the step's queue to fetch its rows", async (t) => {
  let endHandOff;
  const packRequests = [];
  const { tray, requested } = await relaunchWithPending(
    t,
    {
      cleanup: { provider: "qwen", modelId: CLEANUP_LLM, resumable: true },
      assistant: { provider: "qwen", modelId: LLM, resumable: true },
    },
    {
      storage: { pendingLocalGraphicsPackFailures: "0" },
      api: {
        getLlamaVulkanStatus: async () => ({ downloaded: false }),
        downloadLlamaVulkanBinary: async () => {
          packRequests.push("pack");
          return { success: true };
        },
      },
      // The step's Proceed starts its queue before the control panel's tray mounts.
      beforeMount: ({ registry }) => {
        void registry.runLocalSetupHandOff(() => new Promise((resolve) => (endHandOff = resolve)));
      },
    }
  );
  assert.deepEqual(requested, [], "one download at a time: the step's queue has them");
  assert.deepEqual(packRequests, [], "the graphics pack isn't fetched twice");
  await React.act(async () => endHandOff());
  assert.equal(tray.registry.isLocalSetupHandOffRunning(), false);
});
