const assert = require("node:assert/strict");
const test = require("node:test");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

const FIRST_LLM = "qwen3.5-4b-q4_k_m";
const SECOND_LLM = "qwen3.5-2b-q4_k_m";
const PARAKEET = "parakeet-tdt-0.6b-v3";
const LEGACY_LLM = "llama-3.2-3b-instruct-q4_k_m";

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

async function createSetupHarness(
  t,
  {
    assistant = false,
    provider = assistant ? "qwen" : "whisper",
    installed = {},
    selectedModel = "",
    resumeState,
    capability = { supported: true },
    freshInstall = false,
    policy,
  } = {}
) {
  let unmount = async () => {};
  t.after(() => unmount());
  const listeners = { whisper: new Set(), parakeet: new Set(), llm: new Set() };
  const inventory = {
    whisper: new Set(installed.whisper),
    parakeet: new Set(installed.parakeet),
    llm: new Set(installed.llm),
  };
  const requests = new Map();
  const deleted = [];
  const events = new EventTarget();
  const subscribe = (family) => (listener) => {
    listeners[family].add(listener);
    return () => listeners[family].delete(listener);
  };
  const startDownload = (family) => (modelId) =>
    new Promise((resolve) => requests.set(modelId, { family, resolve }));
  installBrowserGlobals(t, {
    window: {
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
      dispatchEvent: events.dispatchEvent.bind(events),
      electronAPI: {
        getPlatform: () => "linux",
        checkParakeetInstallation: async () => capability,
        listWhisperModels: async () => ({
          success: true,
          models: [...inventory.whisper].map((model) => ({ model, downloaded: true })),
        }),
        listParakeetModels: async () => ({
          success: true,
          models: [...inventory.parakeet].map((model) => ({ model, downloaded: true })),
        }),
        modelGetAll: async () =>
          [...inventory.llm].map((id) => ({ id, isDownloaded: true, isDownloading: false })),
        modelGetActiveDownloads: async () => [],
        modelDelete: async (modelId) => {
          deleted.push(modelId);
          inventory.llm.delete(modelId);
          return { success: true };
        },
        downloadWhisperModel: startDownload("whisper"),
        downloadParakeetModel: startDownload("parakeet"),
        modelDownload: startDownload("llm"),
        modelCancelDownload: async (modelId) => {
          const response = {
            success: false,
            code: "DOWNLOAD_CANCELLED",
            error: "Download cancelled by user",
          };
          for (const listener of listeners.llm) {
            listener({}, { type: "error", modelId, code: response.code, error: response.error });
          }
          requests.get(modelId).resolve(response);
          return { success: true };
        },
        onWhisperDownloadProgress: subscribe("whisper"),
        onParakeetDownloadProgress: subscribe("parakeet"),
        onModelDownloadProgress: subscribe("llm"),
      },
    },
  });
  const container = installHookDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-local-setup-test-",
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
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  useSettingsStore.setState({
    localTranscriptionProvider: provider === "nvidia" ? "nvidia" : "whisper",
    whisperModel: !assistant && provider === "whisper" ? selectedModel : "",
    parakeetModel: !assistant && provider === "nvidia" ? selectedModel : "",
    chatAgentProvider: assistant ? provider : "qwen",
    chatAgentModel: assistant ? selectedModel : "",
    chatAgentMode: "local",
  });
  // The store setter also persists the choice; only a fresh install has no key.
  if (!assistant && !freshInstall) {
    localStorage.setItem(
      "localTranscriptionProvider",
      provider === "nvidia" ? "nvidia" : "whisper"
    );
  }
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  if (policy) usePolicyStore.setState(policy);
  const { LocalModelSetupStep } = await vite.ssrLoadModule(
    "/components/onboarding/ProviderSetupStep.tsx"
  );
  const { ToastContext } = await vite.ssrLoadModule("/components/ui/useToast.ts");
  const pending = await vite.ssrLoadModule("/components/onboarding/pendingLocalModels.ts");
  const { default: BackgroundModelDownloadTray } = await vite.ssrLoadModule(
    "/components/onboarding/BackgroundModelDownloadTray.tsx"
  );
  const { LocalModelPolicyNotice } = await vite.ssrLoadModule(
    "/components/ui/LocalModelPolicyNotice.tsx"
  );
  let tree;
  let trayTree;
  let noticeTree;
  let ready = false;
  let proceeded = false;
  let skipped = false;
  const resumeDrafts = [];
  let feedDraftBack = () => {};
  const props = {
    stepId: assistant ? "local-assistant" : "local-dictation",
    onReadinessChange: (value) => {
      ready = value;
    },
    onProceed() {
      proceeded = true;
    },
    onSkip() {
      skipped = true;
    },
    // OnboardingFlow stores each draft in the session and passes it straight back.
    onResumeStateChange: (draft) => {
      resumeDrafts.push(draft);
      feedDraftBack(draft);
    },
  };
  function Harness() {
    const [draft, setDraft] = React.useState(resumeState);
    feedDraftBack = setDraft;
    // Execute the real component and hooks with React lifecycle, while leaving
    // native controls unmounted: their returned handlers are the test boundary.
    tree = LocalModelSetupStep({ ...props, resumeState: draft });
    const notice = findElement(tree, (node) => node.type === LocalModelPolicyNotice);
    noticeTree = LocalModelPolicyNotice(notice.props);
    trayTree = BackgroundModelDownloadTray({ placement: "onboarding" });
    return null;
  }
  const root = createRoot(container);
  const toast = { toast: () => "test-toast" };
  await React.act(async () => {
    root.render(
      React.createElement(ToastContext.Provider, { value: toast }, React.createElement(Harness))
    );
  });
  unmount = async () => {
    await React.act(async () => root.unmount());
  };

  const row = (modelId) => {
    const element = findElement(tree, (node) => node.type === "div" && node.key === modelId);
    assert.ok(element, `model row ${modelId} is visible`);
    return element;
  };
  const click = async (modelId, action) => {
    const button = findElement(
      row(modelId),
      (node) => typeof node.props?.onClick === "function" && textContent(node) === action
    );
    assert.ok(button, `${action} is available for ${modelId}: ${textContent(row(modelId))}`);
    await React.act(async () => button.props.onClick());
  };
  const emit = async (family, event) => {
    await React.act(async () => {
      for (const listener of listeners[family]) listener({}, event);
    });
  };
  const progress = async (modelId, percentage, phase = "progress") => {
    const family = requests.get(modelId).family;
    const event =
      family === "llm"
        ? { modelId, type: phase, progress: percentage, downloadedSize: percentage, totalSize: 100 }
        : {
            model: modelId,
            type: phase,
            percentage,
            downloaded_bytes: percentage,
            total_bytes: 100,
          };
    await emit(family, event);
  };
  const complete = async (modelId) => {
    const request = requests.get(modelId);
    assert.ok(request, `download ${modelId} started`);
    inventory[request.family].add(modelId);
    await React.act(async () => {
      for (const listener of listeners[request.family]) {
        listener(
          {},
          request.family === "llm"
            ? { type: "complete", modelId, progress: 100 }
            : { type: "complete", model: modelId, percentage: 100 }
        );
      }
      request.resolve({ success: true });
    });
  };
  const trayRow = (key) => {
    const element = findElement(trayTree, (node) => node.type === "div" && node.key === key);
    assert.ok(element, `tray row ${key} is visible`);
    return element;
  };
  const actionButton = (label) =>
    findElement(
      tree,
      (node) => typeof node.props?.onClick === "function" && textContent(node) === label
    );
  return {
    store: useSettingsStore,
    setPolicy: async (policy) => {
      await React.act(async () => usePolicyStore.setState(policy));
    },
    pending,
    row,
    click,
    progress,
    complete,
    emit,
    trayRow,
    cancel: async (modelId) => {
      const button = findElement(trayRow(`llm:${modelId}`), (node) => node.type === "button");
      await React.act(async () => button.props.onClick());
    },
    trayHeader: () => {
      const header = findElement(
        trayTree,
        (node) => node.type === "div" && String(node.props?.className).includes("gap-[5px]")
      );
      assert.ok(header, "tray header is visible");
      return textContent(header);
    },
    chooseProvider: async (providerId) => {
      const select = findElement(tree, (node) => typeof node.props?.onValueChange === "function");
      await React.act(async () => select.props.onValueChange(providerId));
    },
    proceed: async () => {
      const button = actionButton("onboarding.rehaul.provider.proceed");
      assert.equal(button.props.disabled, false, "Proceed is enabled");
      await React.act(async () => button.props.onClick());
    },
    skip: async () => {
      const button = actionButton("common.skip");
      assert.ok(button && !button.props.disabled, "Skip is enabled");
      await React.act(async () => button.props.onClick());
    },
    proceeded: () => proceeded,
    skipped: () => skipped,
    ready: () => ready,
    noticeText: () => textContent(noticeTree),
    resumeDrafts: () => resumeDrafts,
    canProceed: () => !actionButton("onboarding.rehaul.provider.proceed").props.disabled,
    canSkip: () => {
      const button = actionButton("common.skip");
      return Boolean(button && !button.props.disabled);
    },
    cohereLanguagePicker: () =>
      findElement(tree, (node) => Array.isArray(node.props?.options) && node.props?.onChange),
    chooseCohereLanguage: async (code) => {
      const picker = findElement(
        tree,
        (node) => Array.isArray(node.props?.options) && node.props?.onChange
      );
      await React.act(async () => picker.props.onChange(code));
    },
    providerListed: (providerId) =>
      Boolean(
        findElement(tree, (node) => node.key === providerId && node.props?.value === providerId)
      ),
    openProvider: () =>
      findElement(tree, (node) => typeof node.props?.onValueChange === "function").props.value,
    hasRow: (modelId) =>
      Boolean(findElement(tree, (node) => node.type === "div" && node.key === modelId)),
    startedDownloads: () => [...requests.keys()],
    deleted,
    clickDelete: async (modelId) => {
      const button = findElement(
        row(modelId),
        (node) => node.props?.["aria-label"] === "common.delete"
      );
      assert.ok(button, `Delete is available for ${modelId}`);
      await React.act(async () => button.props.onClick());
    },
    confirmDialog: () => findElement(tree, (node) => "onConfirm" in (node.props ?? {})),
    flush: () => React.act(async () => new Promise((resolve) => setImmediate(resolve))),
  };
}

for (const fixture of [
  { family: "whisper", provider: "whisper", modelId: "base", setting: "whisperModel" },
  {
    family: "parakeet",
    provider: "nvidia",
    modelId: "parakeet-tdt-0.6b-v3",
    setting: "parakeetModel",
  },
  { family: "llm", provider: "qwen", modelId: FIRST_LLM, setting: "chatAgentModel" },
]) {
  test(`Use selects an installed ${fixture.family} model without a pending download`, async (t) => {
    const setup = await createSetupHarness(t, {
      assistant: fixture.family === "llm",
      provider: fixture.provider,
      installed: { [fixture.family]: [fixture.modelId] },
    });
    assert.equal(setup.canProceed(), false);
    await setup.click(fixture.modelId, "onboarding.rehaul.local.use");
    assert.equal(setup.store.getState()[fixture.setting], fixture.modelId);
    assert.equal(setup.ready(), true);
    assert.equal(setup.canProceed(), true);
  });
}

test("a fresh install opens the local dictation step on Oruk with Orukeet offered", async (t) => {
  const setup = await createSetupHarness(t, { freshInstall: true });
  assert.ok(setup.row("orukeet-v0.1.0"));
  assert.throws(() => setup.row("base"));
});

test("an explicit installed-model choice supersedes an earlier pending download", async (t) => {
  const setup = await createSetupHarness(t, { assistant: true, installed: { llm: [SECOND_LLM] } });
  await setup.click(FIRST_LLM, "onboarding.rehaul.local.download");
  await setup.click(SECOND_LLM, "onboarding.rehaul.local.use");
  assert.equal(setup.pending.hasPendingLocalModels(), false);
  assert.equal(setup.canProceed(), true);
  assert.equal(setup.canSkip(), true);
  await setup.complete(FIRST_LLM);
  assert.equal(setup.store.getState().chatAgentModel, SECOND_LLM);
  assert.equal(setup.ready(), true);
});

test("completion enables Proceed after the background tray consumes the pending selection", async (t) => {
  const setup = await createSetupHarness(t, { assistant: true });
  await setup.click(FIRST_LLM, "onboarding.rehaul.local.download");
  localStorage.setItem("localSetupPending", "true");
  await setup.complete(FIRST_LLM);
  assert.equal(setup.pending.hasPendingLocalModels(), false);
  assert.equal(setup.store.getState().chatAgentModel, FIRST_LLM);
  assert.equal(setup.ready(), true);
  assert.equal(setup.canProceed(), true);
});

test("simultaneous assistant downloads display their own progress", async (t) => {
  const setup = await createSetupHarness(t, { assistant: true });
  await setup.click(FIRST_LLM, "onboarding.rehaul.local.download");
  await setup.click(SECOND_LLM, "onboarding.rehaul.local.download");
  await setup.progress(FIRST_LLM, 10);
  await setup.progress(SECOND_LLM, 80);
  assert.match(textContent(setup.row(FIRST_LLM)), /10%/);
  assert.match(textContent(setup.row(SECOND_LLM)), /80%/);
});

test("the most recently started assistant download owns pending selection", async (t) => {
  const setup = await createSetupHarness(t, { assistant: true });
  await setup.click(FIRST_LLM, "onboarding.rehaul.local.download");
  await setup.click(SECOND_LLM, "onboarding.rehaul.local.download");
  assert.equal(setup.pending.readPendingLocalModels().assistant.modelId, SECOND_LLM);
  await setup.complete(FIRST_LLM);
  assert.equal(setup.store.getState().chatAgentModel, "");
  await setup.complete(SECOND_LLM);
  assert.equal(setup.store.getState().chatAgentModel, SECOND_LLM);
  assert.equal(setup.ready(), true);
});

test("a refused concurrent Whisper download preserves the original pending selection", async (t) => {
  const setup = await createSetupHarness(t);
  await setup.click("base", "onboarding.rehaul.local.download");
  await setup.click("small", "onboarding.rehaul.local.download");
  assert.equal(setup.pending.readPendingLocalModels().dictation.modelId, "base");
  await setup.complete("base");
  assert.equal(setup.store.getState().whisperModel, "base");
  assert.equal(setup.ready(), true);
});

test("cancelling the newest assistant download permits Skip without activating an older model", async (t) => {
  const setup = await createSetupHarness(t, { assistant: true });
  await setup.click(FIRST_LLM, "onboarding.rehaul.local.download");
  await setup.click(SECOND_LLM, "onboarding.rehaul.local.download");
  await setup.progress(FIRST_LLM, 10);
  await setup.progress(SECOND_LLM, 20);
  await setup.cancel(SECOND_LLM);

  assert.equal(setup.pending.hasPendingLocalModels(), false);
  assert.deepEqual(
    { proceed: setup.canProceed(), skip: setup.canSkip() },
    { proceed: false, skip: true }
  );
  await setup.skip();
  assert.equal(setup.skipped(), true);
  await setup.complete(FIRST_LLM);
  assert.equal(setup.store.getState().chatAgentModel, "");
  assert.equal(setup.canProceed(), false);
  await setup.click(FIRST_LLM, "onboarding.rehaul.local.use");
  assert.equal(setup.store.getState().chatAgentModel, FIRST_LLM);
  assert.equal(setup.canProceed(), true);
});

test("cancelling an older assistant download preserves the pending background selection", async (t) => {
  const setup = await createSetupHarness(t, { assistant: true });
  await setup.click(FIRST_LLM, "onboarding.rehaul.local.download");
  await setup.click(SECOND_LLM, "onboarding.rehaul.local.download");
  await setup.progress(FIRST_LLM, 10);
  await setup.progress(SECOND_LLM, 20);
  await setup.cancel(FIRST_LLM);

  assert.equal(setup.pending.readPendingLocalModels().assistant.modelId, SECOND_LLM);
  assert.equal(setup.canProceed(), true);
  assert.equal(setup.canSkip(), true);
  await setup.proceed();
  assert.equal(setup.proceeded(), true);
  assert.equal(localStorage.getItem("localSetupPending"), "true");
  await setup.complete(SECOND_LLM);
  assert.equal(setup.store.getState().chatAgentModel, SECOND_LLM);
  assert.equal(setup.ready(), true);
});

test("browsing another dictation provider preserves the active pending background selection", async (t) => {
  const setup = await createSetupHarness(t);
  await setup.click("base", "onboarding.rehaul.local.download");
  await setup.chooseProvider("nvidia");
  assert.equal(setup.canProceed(), true);
  assert.equal(setup.canSkip(), true);
  await setup.proceed();
  assert.equal(localStorage.getItem("localSetupPending"), "true");
  await setup.complete("base");
  assert.equal(setup.store.getState().localTranscriptionProvider, "whisper");
  assert.equal(setup.store.getState().whisperModel, "base");
});

test("a resumed local-model draft overrides the previously saved model", async (t) => {
  const setup = await createSetupHarness(t, {
    assistant: true,
    installed: { llm: [FIRST_LLM, SECOND_LLM] },
    selectedModel: FIRST_LLM,
    resumeState: { provider: "qwen", modelId: SECOND_LLM },
  });

  assert.match(textContent(setup.row(SECOND_LLM)), /onboarding\.rehaul\.local\.selected/);
  assert.match(textContent(setup.row(FIRST_LLM)), /onboarding\.rehaul\.local\.use/);
  assert.equal(setup.ready(), true);
  assert.equal(setup.canProceed(), true);
});

test("a provider left with nothing to list opens on Qwen instead", async (t) => {
  // The store still names llama after its legacy model was deleted.
  const setup = await createSetupHarness(t, { assistant: true, provider: "llama" });
  assert.equal(setup.providerListed("llama"), false);
  assert.match(textContent(setup.row(FIRST_LLM)), /onboarding\.rehaul\.local\.download/);
});

test("browsing away from an installed legacy model and back restores it", async (t) => {
  const setup = await createSetupHarness(t, {
    assistant: true,
    provider: "llama",
    selectedModel: LEGACY_LLM,
    installed: { llm: [LEGACY_LLM] },
  });
  assert.match(textContent(setup.row(LEGACY_LLM)), /onboarding\.rehaul\.local\.selected/);

  await setup.chooseProvider("qwen");
  assert.equal(setup.providerListed("llama"), true, "the saved model's provider stays reachable");
  assert.equal(setup.ready(), false);

  await setup.chooseProvider("llama");
  assert.match(textContent(setup.row(LEGACY_LLM)), /onboarding\.rehaul\.local\.selected/);
  assert.equal(setup.ready(), true);
  assert.equal(setup.store.getState().chatAgentModel, LEGACY_LLM);
});

test("a selected legacy model that isn't downloaded offers no Download", async (t) => {
  const setup = await createSetupHarness(t, {
    assistant: true,
    provider: "llama",
    resumeState: { provider: "llama", modelId: LEGACY_LLM },
  });
  assert.doesNotMatch(textContent(setup.row(LEGACY_LLM)), /onboarding\.rehaul\.local\.download/);
});

test("Skip marks a pending model for background activation", async (t) => {
  const setup = await createSetupHarness(t, { assistant: true });
  await setup.click(FIRST_LLM, "onboarding.rehaul.local.download");
  assert.equal(setup.canSkip(), true);
  await setup.skip();
  assert.equal(localStorage.getItem("localSetupPending"), "true");
});

test("the assistant step can be skipped with no model selected or downloading", async (t) => {
  const setup = await createSetupHarness(t, { assistant: true });
  assert.equal(setup.canProceed(), false);
  await setup.skip();
  assert.equal(setup.skipped(), true);
});

test("choosing a local model records it in the resume draft", async (t) => {
  const setup = await createSetupHarness(t, {
    assistant: true,
    installed: { llm: [FIRST_LLM, SECOND_LLM] },
    selectedModel: FIRST_LLM,
  });

  await setup.click(SECOND_LLM, "onboarding.rehaul.local.use");

  // Without this the pick is only in component state, so relaunching mid-setup
  // silently reverts to whatever was saved before onboarding started.
  assert.deepEqual(setup.resumeDrafts().at(-1), { provider: "qwen", modelId: SECOND_LLM });
});

test("Oruk installs and activates Orukeet through the existing parakeet download flow", async (t) => {
  const modelId = "orukeet-v0.1.0";
  const setup = await createSetupHarness(t);
  await setup.chooseProvider("oruk");
  assert.match(textContent(setup.row(modelId)), /common\.recommended/);
  assert.equal(setup.store.getState().localTranscriptionProvider, "whisper");
  await setup.click(modelId, "onboarding.rehaul.local.download");
  assert.deepEqual(setup.pending.readPendingLocalModels().dictation, {
    provider: "nvidia",
    modelId,
  });
  await setup.complete(modelId);
  assert.equal(setup.store.getState().localTranscriptionProvider, "nvidia");
  assert.equal(setup.store.getState().parakeetModel, modelId);
  assert.equal(setup.ready(), true);
  assert.equal(setup.canProceed(), true);
});

test("browsing Oruk preserves an installed stock Parakeet selection", async (t) => {
  const modelId = "parakeet-tdt-0.6b-v3";
  const setup = await createSetupHarness(t, {
    provider: "nvidia",
    installed: { parakeet: [modelId] },
  });
  await setup.click(modelId, "onboarding.rehaul.local.use");
  await setup.chooseProvider("oruk");
  assert.equal(setup.store.getState().parakeetModel, modelId);
  assert.equal(setup.store.getState().localTranscriptionProvider, "nvidia");
  assert.equal(setup.ready(), false);
});

test("unsupported Macs cannot choose Oruk or NVIDIA during local onboarding", async (t) => {
  const setup = await createSetupHarness(t, {
    provider: "nvidia",
    capability: { supported: false, minimumMacOSVersion: "15.5" },
  });
  assert.ok(setup.row("base"));
  for (const provider of ["oruk", "nvidia"]) {
    await setup.chooseProvider(provider);
    assert.ok(setup.row("base"));
    assert.equal(setup.ready(), false);
  }
});

test("a fresh install on an unsupported Mac moves to Whisper after its draft came back", async (t) => {
  const setup = await createSetupHarness(t, {
    freshInstall: true,
    capability: { supported: false, minimumMacOSVersion: "15.5" },
  });
  assert.equal(setup.openProvider(), "whisper");
  assert.ok(setup.row("base"));
  assert.equal(setup.resumeDrafts().at(-1).provider, "whisper");
});

test("a resumed Oruk draft on an unsupported Mac moves to Whisper", async (t) => {
  const setup = await createSetupHarness(t, {
    resumeState: { provider: "oruk", modelId: "orukeet-v0.1.0" },
    capability: { supported: false, minimumMacOSVersion: "15.5" },
  });
  assert.equal(setup.openProvider(), "whisper");
  assert.ok(setup.row("base"));
});

test("an unsupported Mac stays on a family that has an installed model to delete", async (t) => {
  const setup = await createSetupHarness(t, {
    provider: "nvidia",
    selectedModel: PARAKEET,
    resumeState: { provider: "nvidia", modelId: PARAKEET },
    installed: { parakeet: [PARAKEET] },
    capability: { supported: false, minimumMacOSVersion: "15.5" },
  });
  assert.equal(setup.openProvider(), "nvidia");
  assert.ok(setup.row(PARAKEET));
  assert.equal(setup.ready(), false);
});

test("the tray header follows the transfer into its installing phase", async (t) => {
  const modelId = "parakeet-tdt-0.6b-v3";
  const setup = await createSetupHarness(t, { provider: "nvidia" });

  await setup.click(modelId, "onboarding.rehaul.local.download");
  await setup.progress(modelId, 100);
  assert.equal(setup.trayHeader(), "onboarding.rehaul.local.downloadInProgress");

  // Extraction reports no further bytes, so the header is the only thing left
  // that can tell a full bar apart from a stalled one.
  await setup.progress(modelId, 100, "installing");
  assert.equal(setup.trayHeader(), "onboarding.rehaul.local.installing");
});

test("an extracting row says so while another model is still downloading", async (t) => {
  const setup = await createSetupHarness(t, { assistant: true });
  await setup.click(FIRST_LLM, "onboarding.rehaul.local.download");
  await setup.progress(FIRST_LLM, 40);

  // The tray outlives the step that started a transfer, so a dictation model
  // picked earlier keeps extracting behind the assistant step.
  await setup.emit("parakeet", { model: PARAKEET, type: "installing", percentage: 100 });

  assert.match(
    textContent(setup.trayRow(`parakeet:${PARAKEET}`)),
    /onboarding\.rehaul\.local\.installing/
  );
  assert.match(textContent(setup.trayRow(`llm:${FIRST_LLM}`)), /40%/);
  // Not every row has reached extraction, so the strip stays on downloading.
  assert.equal(setup.trayHeader(), "onboarding.rehaul.local.downloadInProgress");
});

function localPolicy(allowedSpeech = ["base"], allowedLlm = [FIRST_LLM]) {
  return {
    status: "managed",
    appVersion: "1.11.1",
    policy: {
      transcription: { allowedModes: ["local"], allowedLocalModels: allowedSpeech },
      llm: { allowedModes: ["local"], allowedLocalModels: allowedLlm },
      features: { agentEnabled: true },
      minAppVersion: null,
    },
  };
}

test("blocked installed selections remain inert and deletable without rewriting preferences", async (t) => {
  const setup = await createSetupHarness(t, {
    assistant: true,
    selectedModel: FIRST_LLM,
    installed: { llm: [FIRST_LLM, SECOND_LLM] },
    policy: localPolicy(["base"], [SECOND_LLM]),
  });
  assert.equal(setup.ready(), false);
  assert.doesNotMatch(
    textContent(setup.row(FIRST_LLM)),
    /onboarding\.rehaul\.local\.(selected|use)/
  );
  assert.match(textContent(setup.row(FIRST_LLM)), /models\.policy\.notApproved/);
  assert.equal(setup.store.getState().chatAgentModel, FIRST_LLM);
  await setup.click(SECOND_LLM, "onboarding.rehaul.local.use");
  assert.equal(setup.store.getState().chatAgentModel, SECOND_LLM);
});

test("policy revocation during a download suppresses step and tray activation", async (t) => {
  const setup = await createSetupHarness(t, { assistant: true, policy: localPolicy() });
  await setup.click(FIRST_LLM, "onboarding.rehaul.local.download");
  localStorage.setItem("localSetupPending", "true");
  await setup.setPolicy(localPolicy(["base"], []));
  assert.equal(setup.canProceed(), false);
  await setup.complete(FIRST_LLM);
  assert.equal(setup.store.getState().chatAgentModel, "");
  assert.equal(setup.ready(), false);
});

test("fresh setup offers an approved family when the Orukeet default is blocked", async (t) => {
  const setup = await createSetupHarness(t, { freshInstall: true, policy: localPolicy() });
  assert.ok(setup.row("base"));
  assert.throws(() => setup.row("orukeet-v0.1.0"));
  assert.equal(setup.store.getState().whisperModel, "");
});

test("an old account download cannot activate under a new approved account", async (t) => {
  const setup = await createSetupHarness(t, {
    assistant: true,
    policy: { ...localPolicy(), accountId: "first", authGeneration: 1 },
  });
  await setup.click(FIRST_LLM, "onboarding.rehaul.local.download");
  localStorage.setItem("localSetupPending", "true");
  await setup.setPolicy({ ...localPolicy(), accountId: "second", authGeneration: 2 });
  await setup.complete(FIRST_LLM);
  assert.equal(setup.store.getState().chatAgentModel, "");
  assert.equal(setup.ready(), false);
  assert.equal(setup.pending.hasPendingLocalModels(), false);
});

test("a denied installed speech family still advertises supported approvals in another family", async (t) => {
  const setup = await createSetupHarness(t, {
    provider: "nvidia",
    selectedModel: "orukeet-v0.1.0",
    installed: { parakeet: ["orukeet-v0.1.0"] },
    policy: localPolicy(["base"]),
  });
  assert.equal(setup.noticeText(), "models.policy.guidance");
  assert.equal(setup.store.getState().parakeetModel, "orukeet-v0.1.0");
  await setup.chooseProvider("whisper");
  assert.ok(setup.row("base"));
});

test("a denied installed LLM family still advertises supported approvals in another family", async (t) => {
  const setup = await createSetupHarness(t, {
    assistant: true,
    provider: "llama",
    selectedModel: LEGACY_LLM,
    installed: { llm: [LEGACY_LLM] },
    policy: localPolicy(),
  });
  assert.equal(setup.noticeText(), "models.policy.guidance");
  assert.equal(setup.store.getState().chatAgentModel, LEGACY_LLM);
  await setup.chooseProvider("qwen");
  assert.ok(setup.row(FIRST_LLM));
});

test("Cohere-only approvals stay reachable from a saved Whisper family and preserve provider identity", async (t) => {
  const modelId = "cohere-transcribe-03-2026";
  const setup = await createSetupHarness(t, {
    provider: "whisper",
    selectedModel: "base",
    installed: { whisper: ["base"], parakeet: [modelId] },
    policy: localPolicy([modelId]),
  });
  assert.equal(setup.providerListed("cohere"), true);
  assert.equal(setup.store.getState().whisperModel, "base");
  setup.store.getState().setPreferredLanguage("en");
  await setup.chooseProvider("cohere");
  await setup.click(modelId, "onboarding.rehaul.local.use");
  assert.equal(setup.store.getState().localTranscriptionProvider, "cohere");
  assert.equal(setup.store.getState().cohereModel, modelId);
  await setup.chooseProvider("whisper");
  await setup.chooseProvider("cohere");
  assert.equal(setup.ready(), true);
});

test("a Cohere download activates its own model field through the background tray", async (t) => {
  const modelId = "cohere-transcribe-03-2026";
  const setup = await createSetupHarness(t, { policy: localPolicy([modelId]) });
  setup.store.getState().setPreferredLanguage("en");
  await setup.chooseProvider("cohere");
  await setup.click(modelId, "onboarding.rehaul.local.download");
  assert.deepEqual(setup.pending.readPendingLocalModels().dictation, {
    provider: "cohere",
    modelId,
  });
  await setup.proceed();
  await setup.complete(modelId);
  assert.equal(setup.store.getState().localTranscriptionProvider, "cohere");
  assert.equal(setup.store.getState().cohereModel, modelId);
  assert.equal(setup.ready(), true);
});

test("a member approved only for Gemma opens on Gemma despite the default chat model", async (t) => {
  const modelId = "gemma-4-31b-it-q4_k_m";
  const setup = await createSetupHarness(t, {
    assistant: true,
    provider: "groq",
    selectedModel: "openai/gpt-oss-120b",
    policy: localPolicy(["base"], [modelId]),
  });
  assert.equal(setup.openProvider(), "gemma");
  assert.ok(setup.row(modelId));
  assert.equal(setup.providerListed("qwen"), false);
  assert.equal(setup.store.getState().chatAgentModel, "openai/gpt-oss-120b");
});

test("a resumed draft under a policy that excludes its family opens on an approved one", async (t) => {
  const setup = await createSetupHarness(t, {
    resumeState: { provider: "oruk", modelId: "orukeet-v0.1.0" },
    policy: localPolicy(["base"]),
  });
  assert.equal(setup.openProvider(), "whisper");
  assert.ok(setup.row("base"));
  assert.equal(setup.providerListed("oruk"), false);
  assert.equal(setup.providerListed("nvidia"), false);
  assert.equal(setup.providerListed("cohere"), false);
});

test("a policy arriving after mount re-picks the family with no store write or download", async (t) => {
  const setup = await createSetupHarness(t, {
    resumeState: { provider: "oruk", modelId: "orukeet-v0.1.0" },
    policy: { status: "loading", policy: null, appVersion: null },
  });
  assert.equal(setup.openProvider(), "oruk");
  const before = setup.store.getState();

  await setup.setPolicy(localPolicy(["base"]));
  assert.equal(setup.openProvider(), "whisper");
  assert.ok(setup.row("base"));
  assert.equal(setup.ready(), false);
  assert.deepEqual(setup.startedDownloads(), []);
  const after = setup.store.getState();
  assert.equal(after.whisperModel, before.whisperModel);
  assert.equal(after.parakeetModel, before.parakeetModel);
  assert.equal(after.localTranscriptionProvider, before.localTranscriptionProvider);
});

test("a policy arriving after mount leaves a family with an approved model alone", async (t) => {
  const setup = await createSetupHarness(t, {
    resumeState: { provider: "nvidia", modelId: PARAKEET },
    policy: { status: "loading", policy: null, appVersion: null },
  });
  await setup.setPolicy(localPolicy(["base", PARAKEET]));
  assert.equal(setup.openProvider(), "nvidia");
  assert.ok(setup.row(PARAKEET));
});

test("browsing to a family with only a blocked installed model stays there to delete it", async (t) => {
  const setup = await createSetupHarness(t, {
    installed: { parakeet: [PARAKEET] },
    policy: localPolicy(["base"]),
  });
  assert.equal(setup.providerListed("nvidia"), true);
  assert.equal(setup.providerListed("oruk"), false);
  await setup.chooseProvider("nvidia");
  assert.equal(setup.openProvider(), "nvidia");
  assert.ok(setup.row(PARAKEET));
  assert.doesNotMatch(textContent(setup.row(PARAKEET)), /onboarding\.rehaul\.local\.use/);
});

test("guests get base's speech families: no Cohere unless it's already theirs", async (t) => {
  const setup = await createSetupHarness(t);
  for (const family of ["oruk", "whisper", "nvidia"]) {
    assert.equal(setup.providerListed(family), true, family);
  }
  assert.equal(setup.providerListed("cohere"), false);
});

test("Cohere is offered to a guest who has it installed", async (t) => {
  const setup = await createSetupHarness(t, {
    installed: { parakeet: ["cohere-transcribe-03-2026"] },
  });
  assert.equal(setup.providerListed("cohere"), true);
});

test("an unrestricted managed policy doesn't offer Cohere either", async (t) => {
  const setup = await createSetupHarness(t, { policy: localPolicy(null) });
  assert.equal(setup.providerListed("oruk"), true);
  assert.equal(setup.providerListed("cohere"), false);
});

test("a guest's downloaded legacy model stays hidden, as on base", async (t) => {
  const setup = await createSetupHarness(t, {
    assistant: true,
    installed: { llm: [LEGACY_LLM] },
  });
  assert.equal(setup.providerListed("llama"), false);
  assert.equal(setup.hasRow(LEGACY_LLM), false);
});

test("deleting a blocked installed model from onboarding asks first", async (t) => {
  const setup = await createSetupHarness(t, {
    assistant: true,
    provider: "llama",
    selectedModel: LEGACY_LLM,
    installed: { llm: [LEGACY_LLM] },
    resumeState: { provider: "llama", modelId: LEGACY_LLM },
    policy: localPolicy(["base"], [LEGACY_LLM + "-other"]),
  });
  await setup.chooseProvider("llama");
  await setup.clickDelete(LEGACY_LLM);
  assert.deepEqual(setup.deleted, [], "nothing is deleted before the confirmation");
  const dialog = setup.confirmDialog();
  assert.equal(dialog.props.open, true);
  assert.equal(dialog.props.variant, "destructive");
  await React.act(async () => dialog.props.onConfirm());
  assert.deepEqual(setup.deleted, [LEGACY_LLM]);
});

test("a model finishing while the policy is unresolved activates once it is approved", async (t) => {
  const identity = { accountId: "first", authGeneration: 1 };
  const setup = await createSetupHarness(t, {
    assistant: true,
    policy: { ...localPolicy(), ...identity },
  });
  await setup.click(FIRST_LLM, "onboarding.rehaul.local.download");
  await setup.proceed();
  assert.equal(localStorage.getItem("localSetupPending"), "true");

  const unresolved = { status: "loading", policy: null, appVersion: null };
  await setup.setPolicy({ ...unresolved, accountId: "first", authGeneration: 2 });
  await setup.complete(FIRST_LLM);
  assert.equal(setup.store.getState().chatAgentModel, "");
  assert.equal(setup.pending.readPendingLocalModels().assistant.modelId, FIRST_LLM);

  await setup.setPolicy({ ...localPolicy(), accountId: "first", authGeneration: 2 });
  await setup.flush();
  assert.equal(setup.store.getState().chatAgentModel, FIRST_LLM);
  assert.equal(setup.pending.hasPendingLocalModels(), false);
});

test("a model finishing during a policy error waits, and a later denial drops it", async (t) => {
  const identity = { accountId: "first", authGeneration: 1 };
  const setup = await createSetupHarness(t, {
    assistant: true,
    policy: { ...localPolicy(), ...identity },
  });
  await setup.click(FIRST_LLM, "onboarding.rehaul.local.download");
  await setup.proceed();
  await setup.setPolicy({ status: "error", policy: null, ...identity });
  await setup.complete(FIRST_LLM);
  assert.equal(setup.pending.hasPendingLocalModels(), true);

  await setup.setPolicy({ ...localPolicy(["base"], []), ...identity });
  await setup.flush();
  assert.equal(setup.store.getState().chatAgentModel, "");
  assert.equal(setup.pending.hasPendingLocalModels(), false);
});

test("a token rotation during a download still selects the model on the step", async (t) => {
  const setup = await createSetupHarness(t, {
    assistant: true,
    policy: { ...localPolicy(), accountId: "first", authGeneration: 1 },
  });
  await setup.click(FIRST_LLM, "onboarding.rehaul.local.download");
  await setup.setPolicy({ ...localPolicy(), accountId: "first", authGeneration: 2 });
  await setup.complete(FIRST_LLM);
  await setup.flush();
  assert.equal(setup.store.getState().chatAgentModel, FIRST_LLM);
  assert.equal(setup.ready(), true);
});

test("a model finishing on the step while unresolved is selected when the policy approves it", async (t) => {
  const identity = { accountId: "first", authGeneration: 1 };
  const setup = await createSetupHarness(t, {
    assistant: true,
    policy: { ...localPolicy(), ...identity },
  });
  await setup.click(FIRST_LLM, "onboarding.rehaul.local.download");
  await setup.setPolicy({ status: "loading", policy: null, appVersion: null, ...identity });
  await setup.complete(FIRST_LLM);
  assert.equal(setup.ready(), false);

  await setup.setPolicy({ ...localPolicy(), ...identity });
  await setup.flush();
  assert.equal(setup.store.getState().chatAgentModel, FIRST_LLM);
  assert.equal(setup.ready(), true);
  assert.equal(setup.pending.hasPendingLocalModels(), false);
});

test("with AI text blocked the assistant step shows why and offers only Skip", async (t) => {
  const blocked = localPolicy(["base"], []);
  blocked.policy.llm.allowedModes = [];
  const setup = await createSetupHarness(t, { assistant: true, policy: blocked });
  assert.equal(setup.noticeText(), "models.policy.modeBlocked");
  assert.equal(setup.canProceed(), false);
  await setup.skip();
  assert.equal(setup.skipped(), true);
  assert.equal(setup.pending.hasPendingLocalModels(), false);
  assert.equal(setup.store.getState().chatAgentModel, "");
});

const COHERE = "cohere-transcribe-03-2026";
const cohereSetup = (t) =>
  createSetupHarness(t, {
    provider: "cohere",
    selectedModel: COHERE,
    installed: { parakeet: [COHERE] },
    policy: localPolicy([COHERE]),
  });

test("Cohere asks for a language, since it can't detect one, and waits for it", async (t) => {
  const setup = await cohereSetup(t);
  await setup.chooseProvider("cohere");
  await setup.click(COHERE, "onboarding.rehaul.local.use");
  assert.equal(setup.store.getState().preferredLanguage, "auto");
  assert.equal(setup.canProceed(), false);
  assert.equal(setup.ready(), false);

  const offered = setup.cohereLanguagePicker().props.options.map((option) => option.value);
  assert.ok(offered.includes("de"));
  assert.ok(offered.includes("zh-CN"));
  assert.ok(!offered.includes("auto"));
  assert.ok(!offered.includes("ru"), "Cohere has no Russian");

  await setup.chooseCohereLanguage("de");
  assert.equal(setup.store.getState().preferredLanguage, "de");
  assert.equal(setup.canProceed(), true);
  assert.equal(setup.ready(), true);
});

test("Cohere asks again when the saved language is one it doesn't support", async (t) => {
  const setup = await cohereSetup(t);
  setup.store.getState().setPreferredLanguage("ru");
  await setup.chooseProvider("cohere");
  await setup.click(COHERE, "onboarding.rehaul.local.use");
  assert.equal(setup.canProceed(), false);
  assert.equal(setup.cohereLanguagePicker().props.value, "");
});

test("Cohere keeps a supported language, including a regional variant", async (t) => {
  const setup = await cohereSetup(t);
  setup.store.getState().setPreferredLanguage("zh-TW");
  await setup.chooseProvider("cohere");
  await setup.click(COHERE, "onboarding.rehaul.local.use");
  assert.equal(setup.canProceed(), true);
  assert.equal(setup.cohereLanguagePicker().props.value, "zh-TW");
});

test("a Cohere download can't be left in the background without a language", async (t) => {
  const setup = await createSetupHarness(t, { policy: localPolicy([COHERE]) });
  await setup.chooseProvider("cohere");
  await setup.click(COHERE, "onboarding.rehaul.local.download");
  assert.equal(setup.canProceed(), false);
  assert.equal(setup.canSkip(), false);
  await setup.chooseCohereLanguage("en");
  assert.equal(setup.canProceed(), true);
  assert.equal(setup.canSkip(), true);
});

test("other speech models never ask for a language", async (t) => {
  const setup = await createSetupHarness(t, {
    provider: "whisper",
    selectedModel: "base",
    installed: { whisper: ["base"] },
  });
  assert.equal(setup.store.getState().preferredLanguage, "auto");
  assert.equal(setup.cohereLanguagePicker(), null);
});
