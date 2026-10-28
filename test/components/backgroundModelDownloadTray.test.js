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

async function createTrayHarness(t) {
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
      },
    },
  });
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
