const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHostDom,
} = require("../lib/rendererTestHarness");

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

async function setup(t) {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  const counts = {
    llama: 0,
    vulkan: 0,
    whisper: 0,
    inventory: 0,
    hydration: 0,
    progress: 0,
    disposed: 0,
  };
  const listeners = new Map();
  const api = {
    getPlatform: () => "linux",
    llamaServerStatus: async () => {
      counts.llama++;
      return { running: true, gpuAccelerated: false };
    },
    getLlamaVulkanStatus: async () => {
      counts.vulkan++;
      return { downloaded: true };
    },
    detectVulkanGpu: async () => ({ available: true }),
    whisperServerStatus: async () => {
      counts.whisper++;
      return { gpuAccelerated: false };
    },
    getCudaWhisperStatus: async () => ({
      downloaded: true,
      gpuInfo: { hasNvidiaGpu: true, cudaSupported: true },
    }),
    getVulkanWhisperStatus: async () => ({ downloaded: false, vulkan: { available: true } }),
    listWhisperModels: async () => {
      counts.inventory++;
      return { success: true, models: [{ model: "base", downloaded: true }] };
    },
    listParakeetModels: async () => ({ success: true, models: [] }),
    modelGetActiveDownloads: async () => {
      counts.hydration++;
      return [];
    },
    checkParakeetInstallation: async () => ({ supported: true }),
    whisperGpuRetry: async () => ({ success: true, willRestart: true }),
    llamaGpuReset: async () => ({ success: true }),
    deleteLlamaVulkanBinary: async () => ({ success: true }),
  };
  for (const name of [
    "onLlamaVulkanDownloadProgress",
    "onWhisperDownloadProgress",
    "onParakeetDownloadProgress",
    "onCudaFallbackNotification",
    "onGpuFallbackNotification",
    "onCudaDownloadProgress",
    "onVulkanWhisperDownloadProgress",
  ]) {
    listeners.set(name, new Set());
    api[name] = (callback) => {
      counts.progress++;
      listeners.get(name).add(callback);
      return () => {
        counts.disposed++;
        listeners.get(name).delete(callback);
      };
    };
  }
  const events = new EventTarget();
  installBrowserGlobals(t, {
    window: {
      electronAPI: api,
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
      dispatchEvent: events.dispatchEvent.bind(events),
    },
  });
  const container = installHostDom(t);
  globalThis.__gpuActions = {};
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-gpu-status-",
    noExternal: ["react-i18next"],
    resolveAlias: { "@": path.resolve(__dirname, "../../src") },
    mockModules: {
      "react-i18next": `const t = key => key; export const useTranslation = () => ({t});`,
      "/ui/button": `import React from "react"; export function Button({children, onClick}) { globalThis.__gpuActions[children] = onClick; return React.createElement("button", {onClick}, children); }`,
      "/ui/ProviderTabs": `export function ProviderTabs({providers, onSelect}) { if (providers.some(p => p.id === "dictationCleanup")) globalThis.__gpuLlmTab = onSelect; if (providers.some(p => p.id === "noteRecording")) globalThis.__gpuSpeechTab = onSelect; if (providers.some(p => p.id === "whisper")) globalThis.__gpuProvider = onSelect; return null; }`,
      "/ui/ModelCardList": `export default function ModelCardList() { return null; }`,
      "/LocalModelPicker": `export default function LocalModelPicker() { return null; }`,
      "/ui/dialog": `export const ConfirmDialog = () => null;`,
      "/hooks/useDialogs": `const noop = () => {}; const dialogs = {confirmDialog: {open: false}, showConfirmDialog: noop, hideConfirmDialog: noop}; export const useDialogs = () => dialogs;`,
      "/ui/useToast": `const value = {toast() {}}; export const useToast = () => value;`,
      "/hooks/usePolicy": `const policy = {status: "unmanaged", policy: null}; export const usePolicySnapshot = () => policy;`,
      "/stores/policyStore": `import {create} from "zustand"; export const usePolicyStore = create(() => ({agentAllowed: true})); globalThis.__gpuPolicy = usePolicyStore;`,
      "/stores/policyRules": `export * from "/stores/policyRules.ts"; export const isAgentAllowed = state => state.agentAllowed;`,
      "/stores/settingsStore": `const settings = {useCleanupModel: true, openaiApiKey: "", setOpenaiApiKey() {}}; export const useSettingsStore = selector => selector(settings); export const clearMissingLocalModelSelections = () => {};`,
      "/GpuDeviceSelector": `export default function GpuDeviceSelector() { return null; }`,
      "/ui/PromptStudio": `export default function PromptStudio() { return null; }`,
      "/InferenceConfigEditor": `import React from "react"; import Selector from "/components/ReasoningModelSelector.tsx"; const noop = () => {}; export default function Editor({scope, navigation}) { return React.createElement(Selector, {settingsScope: scope, settingsNavigation: navigation, mode: "local", reasoningModel: "", setReasoningModel: noop, localReasoningProvider: "qwen", setLocalReasoningProvider: noop, cloudReasoningBaseUrl: "", setCloudReasoningBaseUrl: noop}); }`,
      "/DictationAgentSettings": `import React from "react"; import Editor from "/components/settings/InferenceConfigEditor"; export default function Agent({navigation}) { return React.createElement(Editor, {scope: "dictationAgent", navigation}); }`,
      "/DictationTranslationSettings": `import React from "react"; import Editor from "/components/settings/InferenceConfigEditor"; export default function Translation({navigation}) { return React.createElement(Editor, {scope: "dictationTranslation", navigation}); }`,
      "/ChatAgentSettings": `import React from "react"; import Editor from "/components/settings/InferenceConfigEditor"; export default function Chat({navigation}) { return React.createElement(Editor, {scope: "chatIntelligence", navigation}); }`,
    },
  });
  const { default: Llms } = await vite.ssrLoadModule("/components/settings/LlmsSection.tsx");
  const { default: Speech } = await vite.ssrLoadModule("/components/settings/SpeechToTextTabs.tsx");
  const { TabPanel } = await vite.ssrLoadModule("/components/settings/KeepAlive.tsx");
  const { default: Picker } = await vite.ssrLoadModule("/components/TranscriptionModelPicker.tsx");
  const { default: Selector } = await vite.ssrLoadModule("/components/ReasoningModelSelector.tsx");
  const { createSettingsNavigationStore } = await vite.ssrLoadModule(
    "/stores/settingsNavigationStore.ts"
  );
  const navigation = createSettingsNavigationStore(
    undefined,
    () => globalThis.__gpuPolicy.getState().agentAllowed
  );
  const unsubscribePolicy = globalThis.__gpuPolicy.subscribe(() =>
    navigation.getState().reconcilePolicy()
  );
  t.after(unsubscribePolicy);
  const intervals = new Map();
  const originalInterval = globalThis.setInterval,
    originalClear = globalThis.clearInterval;
  let id = 0;
  globalThis.setInterval = (callback, delay) => {
    intervals.set(++id, { callback, delay });
    return id;
  };
  globalThis.clearInterval = (id) => intervals.delete(id);
  const tick = async (delay) => {
    for (const [id, timer] of [...intervals]) {
      if (timer.delay === delay && intervals.has(id)) await React.act(async () => timer.callback());
    }
  };
  root = createRoot(container);
  t.after(() => {
    globalThis.setInterval = originalInterval;
    globalThis.clearInterval = originalClear;
    for (const key of [
      "__gpuActions",
      "__gpuLlmTab",
      "__gpuSpeechTab",
      "__gpuProvider",
      "__gpuPolicy",
    ])
      delete globalThis[key];
  });
  const render = (element) => React.act(async () => root.render(element));
  const close = async () => {
    await React.act(async () => {
      navigation.getState().setSettingsOpen(false);
      root.unmount();
    });
    root = null;
  };
  const renderLlm = (active) =>
    React.act(async () => {
      navigation.getState().openSettings(active ? "llms" : "general");
      root.render(React.createElement(Llms, { navigation }));
    });
  const renderSpeech = (active, panels) =>
    React.act(async () => {
      navigation.getState().openSettings(active ? "speechToText" : "general");
      root.render(
        React.createElement(
          TabPanel,
          { active },
          React.createElement(Speech, { navigation, ...panels })
        )
      );
    });
  const emit = (name, data) =>
    React.act(async () => {
      for (const listener of listeners.get(name)) {
        if (name === "onWhisperDownloadProgress" || name === "onParakeetDownloadProgress")
          listener({}, data);
        else listener(data);
      }
    });
  const props = {
    mode: "local",
    selectedLocalProvider: "whisper",
    selectedLocalModel: "base",
    selectedCloudProvider: "openai",
    selectedCloudModel: "whisper-1",
    useLocalWhisper: true,
    onLocalModelSelect() {},
    onCloudProviderSelect() {},
    onCloudModelSelect() {},
    onModeChange() {},
  };
  const llmProps = {
    mode: "local",
    reasoningModel: "",
    setReasoningModel() {},
    localReasoningProvider: "qwen",
    setLocalReasoningProvider() {},
    cloudReasoningBaseUrl: "",
    setCloudReasoningBaseUrl() {},
  };
  return {
    counts,
    navigation,
    renderLlm,
    renderSpeech,
    api,
    listeners,
    container,
    Llms,
    Speech,
    TabPanel,
    Picker,
    Selector,
    props,
    llmProps,
    tick,
    render,
    close,
    emit,
    intervals,
  };
}

test("retained panels poll only the visible subtab across hide and revisit", async (t) => {
  // One visibility scenario keeps the {llm, speech} flavors' distinct assertions on one shared body.
  for (const flavor of ["llm", "speech"]) {
    const h = await setup(t);
    const isLlm = flavor === "llm";
    const polls = () => (isLlm ? h.counts.llama : h.counts.whisper);
    let renderActive;
    if (isLlm) {
      renderActive = h.renderLlm;
    } else {
      const panels = ["dictation", "meeting", "upload"].map((transcriptionContext) =>
        React.createElement(h.Picker, {
          ...h.props,
          settingsNavigation: h.navigation,
          transcriptionContext,
        })
      );
      renderActive = (active) =>
        h.renderSpeech(active, { dictation: panels[0], noteRecording: panels[1], upload: panels[2] });
    }
    const switchTab = (tab) =>
      React.act(async () => (isLlm ? globalThis.__gpuLlmTab : globalThis.__gpuSpeechTab)(tab));
    await renderActive(true);
    if (isLlm) {
      assert.equal(h.counts.llama, 1);
    } else {
      assert.equal(h.counts.whisper, 1, "hidden initial siblings do not poll");
      assert.equal(h.counts.inventory, 3, "hidden inventory still hydrates");
    }
    const registrations = h.counts.progress;
    await switchTab(isLlm ? "dictationAgent" : "noteRecording");
    await switchTab(isLlm ? "noteFormatting" : "upload");
    const before = polls();
    await h.tick(5000);
    assert.equal(polls() - before, 1, "only visible retained local tab polls");
    if (isLlm) assert.equal(h.counts.vulkan, h.counts.llama);
    await renderActive(false);
    await h.tick(5000);
    assert.equal(polls(), before + 1, "active subtab in hidden section stops routine reads");
    await renderActive(true);
    assert.equal(polls(), before + 2, "revisit refreshes immediately");
    if (isLlm) {
      await switchTab("dictationAgent");
      await React.act(async () => globalThis.__gpuPolicy.setState({ agentAllowed: false }));
      const afterRemoval = h.counts.llama;
      await h.tick(5000);
      assert.equal(h.counts.llama, afterRemoval + 1);
      await React.act(async () => globalThis.__gpuPolicy.setState({ agentAllowed: true }));
      await React.act(async () => h.navigation.getState().openSettings("dictationAgent"));
      const vision = h.counts.llama;
      await h.render(
        React.createElement(h.Selector, {
          ...h.llmProps,
          settingsNavigation: h.navigation,
          settingsScope: "dictationAgentVision",
        })
      );
      assert.equal(h.counts.llama, vision + 1, "a visible agent-vision editor reads its tab status");
      await h.tick(5000);
      assert.equal(h.counts.llama, vision + 2);
      await React.act(async () => h.navigation.getState().openSettings("general"));
      await h.tick(5000);
      assert.equal(h.counts.llama, vision + 2, "a hidden agent-vision editor stops polling");
      await h.close();
      const closed = h.counts.llama;
      await h.tick(5000);
      assert.equal(h.counts.llama, closed);
      assert.equal(h.counts.progress, h.counts.disposed);
    } else {
      assert.equal(h.counts.inventory, 3);
      assert.equal(
        h.counts.progress,
        registrations,
        "visibility does not replace download/fallback listeners"
      );
      await h.close();
    }
  }
});

test("routine replies are ignored after hide, supersession, rejection, provider/mode change and close", async (t) => {
  const h = await setup(t);
  const pending = [];
  h.api.llamaServerStatus = () => {
    h.counts.llama++;
    const reply = deferred();
    pending.push(reply);
    return reply.promise;
  };
  await h.renderLlm(true);
  await h.tick(5000);
  await React.act(async () =>
    pending[1].resolve({ running: true, gpuAccelerated: true, backend: "vulkan" })
  );
  assert.match(h.container.textContent, /gpu.active/);
  await React.act(async () => pending[0].resolve({ running: true, gpuAccelerated: false }));
  assert.match(
    h.container.textContent,
    /gpu.active/,
    "older poll cannot replace current GPU status"
  );
  await h.tick(5000);
  await React.act(async () => pending[2].reject(new Error("status unavailable")));
  assert.match(h.container.textContent, /gpu.active/, "failed reads retain valid status");
  await h.tick(5000);
  await h.renderLlm(false);
  await React.act(async () => pending[3].resolve({ gpuAccelerated: false }));
  assert.match(h.container.textContent, /gpu.active/, "hidden owner ignores its obsolete reply");
  await h.renderLlm(true);
  assert.equal(pending.length, 5, "revisit fetches immediately");

  // Whisper picker act: provider/mode changes fence obsolete replies and never drop progress listeners.
  const replies = [];
  h.api.whisperServerStatus = () => {
    h.counts.whisper++;
    const reply = deferred();
    replies.push(reply);
    return reply.promise;
  };
  await h.render(React.createElement(h.Picker, h.props));
  const registrations = h.counts.progress;
  await React.act(async () => globalThis.__gpuProvider("nvidia"));
  await h.tick(5000);
  assert.equal(replies.length, 1, "another provider does not poll Whisper");
  await React.act(async () => globalThis.__gpuProvider("whisper"));
  assert.equal(replies.length, 2, "returning to Whisper starts a fresh unresolved read");
  await React.act(async () => replies[0].resolve({ gpuAccelerated: true }));
  assert.doesNotMatch(
    h.container.textContent,
    /gpu.active/,
    "obsolete reply cannot activate the current GPU badge"
  );
  await React.act(async () => replies[1].resolve({ gpuAccelerated: true }));
  assert.match(h.container.textContent, /gpu.active/, "current reply activates the same badge");
  assert.equal(
    h.counts.progress,
    registrations,
    "provider/mode changes keep the progress listeners"
  );
  await h.render(React.createElement(h.Picker, { ...h.props, mode: "cloud" }));
  await h.tick(5000);
  assert.equal(h.counts.whisper, 2);

  await h.close();
  await React.act(async () => pending[4].resolve({ gpuAccelerated: false }));
  assert.equal(h.intervals.size, 0);
});

test("Whisper hidden activation, progress, completion and fallback remain live", async (t) => {
  const h = await setup(t);
  const polls = [];
  h.api.whisperServerStatus = () => {
    h.counts.whisper++;
    const reply = deferred();
    polls.push(reply);
    return reply.promise;
  };
  const retry = deferred();
  h.api.whisperGpuRetry = () => retry.promise;
  const picker = React.createElement(h.Picker, { ...h.props, settingsNavigation: h.navigation });
  const render = (active) => h.renderSpeech(active, { dictation: picker });
  await render(true);
  // Main saves the failure before broadcasting, and the card now re-reads it.
  h.api.getCudaWhisperStatus = async () => ({
    downloaded: true,
    gpuFailed: true,
    gpuFailReason: "synthetic GPU failure",
    gpuInfo: { hasNvidiaGpu: true, cudaSupported: true },
  });
  await h.emit("onCudaFallbackNotification", {});
  await React.act(async () => polls[0].resolve({ gpuAccelerated: true }));
  assert.match(h.container.textContent, /gpu.activationFailed/, "fallback beats pre-event poll");
  assert.match(h.container.textContent, /synthetic GPU failure/);
  let action;
  await React.act(async () => {
    action = globalThis.__gpuActions["gpu.retryActivation"]();
  });
  await render(false);
  await React.act(async () => retry.resolve({ success: true, willRestart: true }));
  await action;
  assert.match(h.container.textContent, /gpu.activating/);
  const before = h.counts.whisper;
  await h.tick(1000);
  assert.equal(h.counts.whisper, before + 1, "activation still polls the hidden picker");
  await h.emit("onGpuFallbackNotification", {});
  await React.act(async () => polls.at(-1).resolve({ gpuAccelerated: true }));
  assert.match(h.container.textContent, /gpu.activationFailed/);
  const afterFallback = h.counts.whisper;
  await h.tick(1000);
  await h.tick(5000);
  assert.equal(h.counts.whisper, afterFallback, "settled hidden owner has no routine timer");
  const inventory = h.counts.inventory;
  await h.emit("onWhisperDownloadProgress", {
    type: "progress",
    model: "tiny",
    percentage: 42,
    sequence: 1,
  });
  assert.match(h.container.textContent, /42/);
  await h.emit("onWhisperDownloadProgress", { type: "complete", model: "tiny", sequence: 2 });
  assert.equal(h.counts.inventory, inventory + 1, "hidden download completion refreshes inventory");
  await render(true);
  assert.equal(h.counts.whisper, afterFallback + 1);
  await h.close();
});

test("a hidden GPU-pack download finishes and activation polls without routine reads", async (t) => {
  const h = await setup(t);
  h.api.getCudaWhisperStatus = async () => ({
    downloaded: false,
    needsUpdate: true,
    gpuInfo: { hasNvidiaGpu: false, cudaSupported: false },
  });
  const download = deferred();
  let picker = React.createElement(h.Picker, { ...h.props, settingsNavigation: h.navigation });
  const render = (active) => h.renderSpeech(active, { dictation: picker });
  await render(true);
  assert.match(h.container.textContent, /gpu.redownloadNeeded/);
  h.api.downloadCudaWhisperBinary = async () => ({ success: false, error: "pack unavailable" });
  await React.act(async () => globalThis.__gpuActions["gpu.redownloadButton"]());
  assert.match(h.container.textContent, /gpu.downloadFailed.*pack unavailable/);
  assert.match(h.container.textContent, /gpu.redownloadNeeded/, "failed update stays retryable");
  h.api.getCudaWhisperStatus = async () => ({
    downloaded: false,
    gpuInfo: { hasNvidiaGpu: true, cudaSupported: true },
  });
  await React.act(async () => globalThis.__gpuProvider("nvidia"));
  await React.act(async () => globalThis.__gpuProvider("whisper"));
  h.api.downloadCudaWhisperBinary = () => download.promise;
  let action;
  await React.act(async () => {
    action = globalThis.__gpuActions["gpu.enableButton"]();
  });
  assert.doesNotMatch(h.container.textContent, /gpu.downloadFailed/);
  await render(false);
  await h.emit("onCudaDownloadProgress", { percentage: 57, downloadedBytes: 57, totalBytes: 100 });
  assert.match(h.container.textContent, /57/);
  await React.act(async () => download.resolve({ success: true, willRestart: true }));
  await action;
  const before = h.counts.whisper;
  await h.tick(1000);
  assert.equal(h.counts.whisper, before + 1);
  h.api.whisperServerStatus = async () => {
    h.counts.whisper++;
    return { gpuAccelerated: true };
  };
  await h.tick(1000);
  assert.match(h.container.textContent, /gpu.active/);
  const settled = h.counts.whisper;
  await h.tick(5000);
  assert.equal(h.counts.whisper, settled);
  await render(true);
  assert.equal(h.counts.whisper, settled + 1);

  // Reopened Settings discovers a native download with no pending renderer action.
  h.api.getCudaWhisperStatus = async () => ({
    downloaded: false,
    downloading: true,
    needsUpdate: true,
    gpuInfo: { hasNvidiaGpu: false, cudaSupported: false },
  });
  picker = React.createElement(h.Picker, {
    ...h.props,
    key: "resumed",
    settingsNavigation: h.navigation,
  });
  await render(true);
  await render(false);
  await h.emit("onCudaDownloadProgress", { percentage: 73, downloadedBytes: 73, totalBytes: 100 });
  assert.match(h.container.textContent, /73/);
  const resumed = [];
  h.api.getCudaWhisperStatus = () => {
    const reply = deferred();
    resumed.push(reply);
    return reply.promise;
  };
  const resumePoll = [...h.intervals.values()].find((timer) => timer.delay === 1000).callback;
  let firstPoll, latestPoll;
  await React.act(async () => {
    firstPoll = resumePoll();
    latestPoll = resumePoll();
  });
  await React.act(async () => resumed[1].resolve(undefined));
  await latestPoll;
  assert.match(h.container.textContent, /73/, "unavailable status cannot finish the download");
  await React.act(async () => resumed[0].resolve({ downloaded: true, downloading: false }));
  await firstPoll;
  assert.match(h.container.textContent, /73/, "obsolete pack reply cannot finish the download");
  h.api.getCudaWhisperStatus = async () => ({
    downloaded: true,
    downloading: false,
    needsUpdate: false,
    gpuFailed: true,
  });
  await h.tick(1000);
  assert.match(
    h.container.textContent,
    /gpu.activationFailed/,
    "current hidden completion settles"
  );
  assert.doesNotMatch(h.container.textContent, /gpu.redownloadNeeded/);
  assert.equal(h.intervals.size, 0, "resumed completion stops polling once hidden and settled");

  // Folded from the LLM pack-completion test: the same hidden-download
  // contract on the LLM side, plus its unique stale-reply fence.
  const packs = [];
  h.api.getLlamaVulkanStatus = () => {
    h.counts.vulkan++;
    const reply = deferred();
    packs.push(reply);
    return reply.promise;
  };
  const packDownload = deferred();
  h.api.downloadLlamaVulkanBinary = () => packDownload.promise;
  await h.renderLlm(true);
  await React.act(async () => packs[0].resolve({ downloaded: false }));
  await h.tick(5000);
  let packAction;
  await React.act(async () => {
    packAction = globalThis.__gpuActions["gpu.enableButton"]();
  });
  await h.renderLlm(false);
  await h.emit("onLlamaVulkanDownloadProgress", { percentage: 61 });
  assert.match(h.container.textContent, /61/);
  await React.act(async () => packDownload.resolve({ success: true }));
  await packAction;
  assert.match(
    h.container.textContent,
    /gpu.ready/,
    "pack completion retains existing ready semantics"
  );
  await React.act(async () => packs[1].resolve({ downloaded: false }));
  assert.match(h.container.textContent, /gpu.ready/, "old pack metadata cannot undo completion");
});

test("completed LLM pack download still resets native state after Settings close", async (t) => {
  const h = await setup(t);
  h.api.getLlamaVulkanStatus = async () => ({ downloaded: false });
  const download = deferred();
  h.api.downloadLlamaVulkanBinary = () => download.promise;
  let resets = 0;
  h.api.llamaGpuReset = async () => {
    resets++;
    return { success: true };
  };
  await h.render(React.createElement(h.Selector, h.llmProps));
  let action;
  await React.act(async () => {
    action = globalThis.__gpuActions["gpu.enableButton"]();
  });
  await h.close();
  await React.act(async () => download.resolve({ success: true }));
  await action;
  assert.equal(resets, 1);
  assert.equal(h.intervals.size, 0);
});

test("non-Settings callers poll independently and StrictMode cleans obsolete reads", async (t) => {
  const h = await setup(t);
  const pending = [];
  h.api.llamaServerStatus = () => {
    h.counts.llama++;
    const reply = deferred();
    pending.push(reply);
    return reply.promise;
  };
  await h.render(
    React.createElement(
      React.StrictMode,
      null,
      React.createElement(h.Selector, h.llmProps),
      React.createElement(h.Picker, h.props)
    )
  );
  assert.equal(pending.length, 2);
  assert.equal(h.intervals.size, 2, "one timer per current non-Settings status reader");
  await React.act(async () => pending[1].resolve({ gpuAccelerated: true, backend: "vulkan" }));
  await React.act(async () => pending[0].resolve({ gpuAccelerated: false }));
  assert.match(h.container.textContent, /gpu.active/);
  const before = [h.counts.llama, h.counts.whisper];
  await h.tick(5000);
  assert.deepEqual(
    [h.counts.llama, h.counts.whisper],
    before.map((count) => count + 1)
  );
  await h.close();
  await React.act(async () => pending.at(-1).resolve({ gpuAccelerated: false }));
  assert.equal(h.intervals.size, 0);
});
