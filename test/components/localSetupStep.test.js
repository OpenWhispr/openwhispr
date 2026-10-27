const assert = require("node:assert/strict");
const test = require("node:test");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHostDom,
} = require("../lib/rendererTestHarness");

// "We recommend these settings": the real screen, hooks and download queue,
// mounted into the harness's host DOM. Translations come back as their keys,
// with any interpolation values appended as JSON.
const K = "onboarding.rehaul.localSetup.";
const DICTATION = "parakeet-unified-en-0.6b";
const CLEANUP = "qwen3.5-2b-q4_k_m";
const ASSISTANT = "qwen3.5-4b-q4_k_m";
const FACTORS = { whisper: 1.2, parakeet: 2.5, llm: 1.2, llamaVulkan: 2.5 };
const PLENTY = 200e9;
const UNMANAGED = { status: "unmanaged", policy: null, appVersion: null };
const BOTH_ON = { cleanup: true, assistant: true };

const mac = (o) => ({
  platform: "darwin",
  arch: "arm64",
  name: "MacBook Pro",
  formFactor: "laptop",
  processorName: "Apple M5 Pro",
  appleChip: { generation: 5, tier: "Pro" },
  memoryGb: 48,
  graphicsName: null,
  nvidia: null,
  parakeetSupported: true,
  systemLanguage: "en",
  ...o,
});
const pc = (o) => ({
  platform: "win32",
  arch: "x64",
  name: null,
  formFactor: "laptop",
  processorName: "Intel Core i5-1235U",
  appleChip: null,
  memoryGb: 16,
  graphicsName: "Intel Iris Xe",
  nvidia: null,
  parakeetSupported: true,
  systemLanguage: "en",
  ...o,
});
const rtx = { name: "NVIDIA GeForce RTX 4060", vramMb: 8188 };

function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

function* walk(node) {
  yield node;
  for (const child of node.childNodes ?? []) yield* walk(child);
}
const elements = (root, predicate) =>
  [...walk(root)].filter((node) => node.nodeType === 1 && predicate(node));
const cls = (node) => node.attributes.class ?? "";
function reactProps(node) {
  const key = Object.keys(node).find((name) => name.startsWith("__reactProps$"));
  return node[key];
}

function makeApi({
  onDisk = {},
  availableBytes = PLENTY,
  active = [],
  holdInventory = false,
} = {}) {
  // Held, the on-disk lists answer only once the test releases them.
  const inventory = holdInventory ? deferred() : { promise: Promise.resolve() };
  const listeners = { whisper: new Set(), parakeet: new Set(), llm: new Set() };
  const listen = (family) => (listener) => {
    listeners[family].add(listener);
    return () => listeners[family].delete(listener);
  };
  const calls = {
    parakeet: [],
    whisper: [],
    llm: [],
    vulkan: 0,
    cancelParakeet: 0,
    cancelLlm: [],
    cancelVulkan: 0,
  };
  const pending = {};
  const start = (family) => (id) => {
    calls[family].push(id);
    pending[id] = deferred();
    return pending[id].promise;
  };
  const listed = (ids = []) => ({
    success: true,
    models: ids.map((model) => ({ model, downloaded: true })),
  });
  const api = {
    onWhisperDownloadProgress: listen("whisper"),
    onParakeetDownloadProgress: listen("parakeet"),
    onModelDownloadProgress: listen("llm"),
    onLlamaVulkanDownloadProgress: () => () => {},
    modelGetActiveDownloads: async () => active,
    listWhisperModels: () => inventory.promise.then(() => listed(onDisk.whisper)),
    listParakeetModels: () => inventory.promise.then(() => listed(onDisk.parakeet)),
    modelGetAll: () =>
      inventory.promise.then(() =>
        (onDisk.llm ?? []).map((id) => ({ id, isDownloaded: true }))
      ),
    getLlamaVulkanStatus: async () => ({ supported: true, downloaded: !!onDisk.pack }),
    getLocalSetupSpace: async () => ({ availableBytes, factors: FACTORS }),
    downloadWhisperModel: start("whisper"),
    downloadParakeetModel: start("parakeet"),
    modelDownload: start("llm"),
    downloadLlamaVulkanBinary() {
      calls.vulkan++;
      pending.pack = deferred();
      return pending.pack.promise;
    },
    async cancelParakeetDownload() {
      calls.cancelParakeet++;
      return { success: true };
    },
    async cancelWhisperDownload() {
      return { success: true };
    },
    async modelCancelDownload(id) {
      calls.cancelLlm.push(id);
      return { success: true };
    },
    async cancelLlamaVulkanDownload() {
      calls.cancelVulkan++;
      return { success: true };
    },
  };
  return { api, calls, pending, listeners, onDisk, inventory };
}

// The plan as the screen gets it, for sizing tests without mounting twice.
async function planFor(profile = mac(), spokenLanguages = ["en-US"]) {
  const { buildLocalSetupPlan } = await import("../../src/config/localSetup.ts");
  return buildLocalSetupPlan({ profile, spokenLanguages, policy: UNMANAGED });
}

async function mount(
  t,
  {
    profile = mac(),
    spokenLanguages = ["en-US"],
    requiredSpeechModelId,
    mapPlan = (p) => p,
    ...apiOptions
  } = {}
) {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  const { api, calls, pending, listeners, onDisk, inventory } = makeApi(apiOptions);
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
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-local-setup-step-test-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `
        const t = (key, options) => (options ? key + " " + JSON.stringify(options) : key);
        const i18n = { language: "en" };
        export function useTranslation() { return { t, i18n }; }
        export const initReactI18next = { type: "3rdParty", init() {} };
      `,
      "/ui/ProviderIcon": `
        import { createElement } from "react";
        export function ProviderIcon({ provider, className }) {
          return createElement("span", { "data-provider": provider, className });
        }
      `,
      "/components/ui/useToast": `
        const value = { toast() {} };
        export function useToast() { return value; }
      `,
      "/stores/settingsStore": `export function clearMissingLocalModelSelections() {}`,
    },
  });
  const step = await vite.ssrLoadModule("/components/onboarding/LocalSetupStep.tsx");
  const { LocalSetupStep } = step;
  const setup = await vite.ssrLoadModule("/config/localSetup.ts");
  const claims = await vite.ssrLoadModule("/components/onboarding/localSetupDownloadClaims.ts");
  const plan = mapPlan(
    setup.buildLocalSetupPlan({
      profile,
      spokenLanguages,
      policy: UNMANAGED,
      requiredSpeechModelId,
    })
  );
  const proceeded = [];

  root = createRoot(container);
  await React.act(async () =>
    root.render(
      React.createElement(LocalSetupStep, {
        plan,
        onProceed: (switches) => proceeded.push(switches),
      })
    )
  );

  const flush = () =>
    React.act(async () => {
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });
  await flush();

  const row = (id) => {
    const [match] = elements(container, (node) => node.attributes["data-local-setup-row"] === id);
    assert.ok(match, `row ${id} is on screen`);
    return match;
  };
  const switchOf = (id) => elements(row(id), (node) => node.attributes.role === "switch")[0];
  const button = () => {
    const [match] = elements(
      container,
      (node) => node.localName === "button" && node.textContent.includes(`${K}button.`)
    );
    assert.ok(match, "the setup button is on screen");
    return match;
  };
  const click = async (node) => {
    await React.act(async () => reactProps(node).onClick({}));
    await flush();
  };
  const finish = async (id, result = { success: true }) => {
    await React.act(async () => pending[id].resolve(result));
    await flush();
  };
  // A progress event from main, as the download IPC channels send it.
  const emit = async (family, data) => {
    await React.act(async () => {
      for (const listener of listeners[family]) listener({}, data);
    });
    await flush();
  };
  const releaseInventory = async () => {
    await React.act(async () => inventory.resolve());
    await flush();
  };
  const unmount = async () => {
    await React.act(async () => root.unmount());
    root = null;
    await flush();
  };
  const foot = () => {
    const [match] = elements(container, (node) => node.attributes["data-local-setup-foot"] != null);
    assert.ok(match, "the foot line is on screen");
    return match.textContent;
  };
  return {
    container,
    plan,
    setup,
    claims,
    step,
    emit,
    onDisk,
    releaseInventory,
    calls,
    proceeded,
    row,
    switchOf,
    button,
    click,
    finish,
    unmount,
    foot,
  };
}

const isDisabled = (node) => node.hasAttribute("disabled");
const ticks = (node) => elements(node, (el) => cls(el).includes("--onboarding-success"));
const pieRings = (node) =>
  elements(node, (el) => el.localName === "circle" && el.attributes.r === "10");
const bytesOf = (plan, id) => plan.rows.find((r) => r.id === id).download.bytes;

test("idle M5 English shows three rows, both switches on, Download models", async (t) => {
  const s = await mount(t);
  const ids = elements(s.container, (node) => node.attributes["data-local-setup-row"] != null).map(
    (node) => node.attributes["data-local-setup-row"]
  );
  assert.deepEqual(ids, ["dictation", "cleanup", "assistant"]);
  assert.equal(s.switchOf("dictation"), undefined, "dictation has no switch");
  assert.equal(s.switchOf("cleanup").attributes["aria-checked"], "true");
  assert.equal(s.switchOf("assistant").attributes["aria-checked"], "true");
  assert.match(s.button().textContent, /button\.download$/);
  assert.equal(isDisabled(s.button()), false);

  assert.match(s.row("dictation").textContent, /line\.dictationSeconds \{"seconds":"2"\}/);
  assert.match(s.row("cleanup").textContent, /line\.cleanupUnderSecond/);
  assert.match(s.row("assistant").textContent, /line\.assistantSeconds \{"seconds":"5"\}/);
  assert.match(s.row("dictation").textContent, /badge\.fast/);
  assert.match(s.row("assistant").textContent, /badge\.slower/);

  const text = s.container.textContent;
  for (const piece of ["MacBook Pro", "Apple M5 Pro", "English", `${K}computer.chip`]) {
    assert.ok(text.includes(piece), `card shows ${piece}`);
  }
  assert.ok(text.includes(`${K}computer.memoryValue {"gb":48}`));
  assert.ok(text.includes(`${K}computer.builtIn`));
  assert.equal(s.foot(), `${K}foot.default`);
  assert.equal(ticks(s.container).length, 0);
  assert.equal(pieRings(s.container).length, 0, "no pie before the download starts");
});

test("badge sits on the model line and never wraps", async (t) => {
  const s = await mount(t);
  for (const id of ["dictation", "cleanup", "assistant"]) {
    const row = s.row(id);
    const planRow = s.plan.rows.find((r) => r.id === id);
    const [badge] = elements(
      row,
      (node) =>
        node.textContent.startsWith(`${K}badge.`) &&
        node.childNodes.every((child) => child.nodeType === 3)
    );
    assert.ok(badge, `${id} has a badge`);
    assert.match(cls(badge), /rounded-\[47px\]/);
    assert.match(cls(badge), /bg-\[var\(--onboarding-surface-tertiary\)\]/);
    const line = badge.parentNode;
    assert.match(cls(line), /whitespace-nowrap/);
    assert.ok(line.textContent.includes(planRow.modelName), "the badge shares the model's line");
    assert.ok(line.textContent.includes(s.setup.rowSizeLabel(planRow, null)));
  }
});

test("rows keep one fixed height class from idle to finished", async (t) => {
  const s = await mount(t);
  const heights = () =>
    ["dictation", "cleanup", "assistant"].map((id) =>
      cls(s.row(id))
        .split(/\s+/)
        .filter((c) => /^(min-|max-)?h-/.test(c))
    );
  const fixed = [["h-24"], ["h-24"], ["h-24"]];
  assert.deepEqual(heights(), fixed, "idle");
  await s.click(s.button());
  assert.deepEqual(heights(), fixed, "downloading");
  await s.finish(DICTATION);
  await s.finish(CLEANUP);
  await s.finish(ASSISTANT);
  assert.match(s.button().textContent, /button\.proceed$/);
  assert.deepEqual(heights(), fixed, "finished");
});

test("Windows 16 GB shows the assistant as Too slow with Cloud recommended and no switch", async (
  t
) => {
  const s = await mount(t, { profile: pc() });
  const assistant = s.row("assistant").textContent;
  assert.ok(assistant.includes(`${K}unavailable.tooSlow`));
  assert.ok(assistant.includes(`${K}badge.cloud`));
  assert.ok(
    assistant.includes(`${K}unavailable.tooSlowMinutes {"model":"Qwen3.5 4B","minutes":3}`),
    assistant
  );
  assert.ok(!assistant.includes("2.7 GB"), "an unavailable row shows no size");
  const [reason] = elements(s.row("assistant"), (n) =>
    n.textContent.startsWith(`${K}unavailable.tooSlowMinutes`)
  );
  assert.match(cls(reason), /\bline-clamp-2\b/, "the reason may take two lines");
  assert.doesNotMatch(cls(reason), /\btruncate\b/);
  assert.equal(s.switchOf("assistant"), undefined);
  assert.ok(elements(s.row("assistant"), (n) => n.textContent === "–").length, "a dash tile");
  assert.equal(s.switchOf("cleanup").attributes["aria-checked"], "true");
  assert.match(s.row("cleanup").textContent, /line\.cleanupAddsSeconds \{"seconds":"5–10"\}/);
  assert.match(s.row("cleanup").textContent, /badge\.slower/);

  const text = s.container.textContent;
  assert.ok(text.includes(`${K}computer.windowsLaptop`));
  assert.ok(text.includes(`${K}computer.processor`));
  assert.ok(text.includes("Intel Core i5-1235U"));
  assert.ok(text.includes("Intel Iris Xe"));
  assert.ok(!text.includes(`${K}computer.chip`));
});

test("switching cleanup off dims it, swaps its line, drops it from the download", async (t) => {
  const s = await mount(t);
  const planRow = s.plan.rows.find((r) => r.id === "cleanup");
  await s.click(s.switchOf("cleanup"));

  assert.equal(s.switchOf("cleanup").attributes["aria-checked"], "false");
  const row = s.row("cleanup");
  assert.ok(elements(row, (n) => /\bopacity-55\b/.test(cls(n))).length, "the row dims");
  assert.ok(row.textContent.includes(`${K}line.off`));
  assert.ok(!row.textContent.includes(`${K}line.cleanupUnderSecond`));
  assert.ok(row.textContent.includes(planRow.modelName), "keeps its name");
  assert.ok(row.textContent.includes(s.setup.rowSizeLabel(planRow, null)), "keeps its size");

  await s.click(s.button());
  await s.finish(DICTATION);
  assert.deepEqual(s.calls.llm, [ASSISTANT]);
});

test("downloading greys the button and locks the switches", async (t) => {
  const s = await mount(t);
  await s.click(s.button());

  assert.deepEqual(s.calls.parakeet, [DICTATION]);
  assert.ok(isDisabled(s.button()));
  assert.match(s.button().textContent, /button\.downloading/);
  assert.match(cls(s.button()), /onboarding-surface-secondary/, "the button turns grey");
  for (const id of ["cleanup", "assistant"]) {
    assert.ok(isDisabled(s.switchOf(id)), `${id} switch is locked`);
    await s.click(s.switchOf(id));
    assert.equal(s.switchOf(id).attributes["aria-checked"], "true", `${id} stays on`);
  }
  // A pie over every queued row: the active one and the two waiting behind it.
  for (const id of ["dictation", "cleanup", "assistant"]) {
    assert.equal(pieRings(s.row(id)).length, 1, `${id} shows the pie ring`);
    assert.ok(
      elements(s.row(id), (n) => n.attributes["data-provider"] && /opacity-30/.test(cls(n)))
        .length,
      `${id} icon fades under the pie`
    );
  }
});

test("Proceed only after every switched-on row is done", async (t) => {
  const s = await mount(t);
  await s.click(s.button());
  await s.finish(DICTATION);
  assert.match(s.button().textContent, /button\.downloading/);
  assert.equal(ticks(s.row("dictation")).length, 1, "dictation shows its tick");
  await s.finish(CLEANUP);
  assert.match(s.button().textContent, /button\.downloading/);
  assert.ok(isDisabled(s.button()));
  await s.finish(ASSISTANT);
  assert.match(s.button().textContent, /button\.proceed$/);
  assert.equal(isDisabled(s.button()), false);
  assert.equal(ticks(s.container).length, 3);
  assert.equal(pieRings(s.container).length, 0);

  await s.click(s.button());
  assert.deepEqual(s.proceeded, [BOTH_ON]);
});

test("a failed row shows Retry and Proceed stays locked", async (t) => {
  const s = await mount(t);
  await s.click(s.button());
  await s.finish(DICTATION);
  await s.finish(CLEANUP, { success: false, error: "network down", code: "NETWORK" });
  await s.finish(ASSISTANT);

  const [retry] = elements(
    s.row("cleanup"),
    (n) => n.localName === "button" && n.textContent === `${K}retry`
  );
  assert.ok(retry, "the failed row offers Retry");
  assert.ok(!s.row("cleanup").textContent.includes(`${K}badge.fast`), "Retry takes the badge slot");
  assert.match(s.button().textContent, /button\.proceed$/, "the button still reads Proceed");
  assert.ok(cls(s.button()).includes("--onboarding-surface-secondary"), "greyed");
  assert.ok(isDisabled(s.button()), "Proceed stays locked");
  await s.click(s.button());
  assert.deepEqual(s.proceeded, []);

  await s.click(retry);
  assert.deepEqual(s.calls.llm, [CLEANUP, ASSISTANT, CLEANUP]);
  await s.finish(CLEANUP);
  assert.match(s.button().textContent, /button\.proceed$/);
  assert.equal(isDisabled(s.button()), false);
});

test("joining a transfer already under way ends as done when it completes", async (t) => {
  // An older build's download of the same model is still running when the screen opens.
  const resumed = {
    modelType: "parakeet",
    modelId: DICTATION,
    phase: "downloading",
    progress: 40,
    downloadedBytes: 0,
    totalBytes: 0,
    sequence: 5,
  };
  const s = await mount(t, { active: [resumed] });
  await s.click(s.button());
  assert.deepEqual(s.calls.parakeet, [], "the running transfer is joined, not restarted");
  assert.equal(elements(s.row("dictation"), (n) => n.textContent === `${K}retry`).length, 0);

  s.onDisk.parakeet = [DICTATION];
  await s.emit("parakeet", { model: DICTATION, type: "complete", sequence: 6 });
  assert.equal(ticks(s.row("dictation")).length, 1, "the joined transfer finished the row");
  assert.deepEqual(s.calls.llm, [CLEANUP], "the queue moves on");
});

test("low space trims the assistant and shows the needs line", async (t) => {
  const probe = await planFor();
  const need = bytesOf(probe, "dictation") * 2.5 + bytesOf(probe, "cleanup") * 1.2;
  const availableBytes = need + 0.2e9;
  const s = await mount(t, { availableBytes });

  assert.equal(s.switchOf("assistant").attributes["aria-checked"], "false");
  assert.equal(s.switchOf("cleanup").attributes["aria-checked"], "true");
  assert.ok(s.row("assistant").textContent.includes(`${K}line.offToFit`));
  const needed = (need / 1e9).toFixed(1);
  const free = (availableBytes / 1e9).toFixed(1);
  assert.equal(s.foot(), `${K}foot.needsMac {"needed":"${needed}","free":"${free}"}`);
  assert.match(s.button().textContent, /button\.download$/);
  assert.equal(isDisabled(s.button()), false);

  // Turned back on by hand, it is kept on: the download no longer fits.
  await s.click(s.switchOf("assistant"));
  assert.equal(s.switchOf("assistant").attributes["aria-checked"], "true");
  assert.ok(!s.row("assistant").textContent.includes(`${K}line.offToFit`));
  assert.match(s.button().textContent, /button\.noSpace$/);
  assert.ok(isDisabled(s.button()));
  assert.match(s.foot(), /foot\.needsMac/);
});

test("no space for dictation disables the button", async (t) => {
  const dictationNeed = bytesOf(await planFor(), "dictation") * 2.5;
  const availableBytes = dictationNeed - 0.1e9;
  const s = await mount(t, { availableBytes, profile: mac({ name: null }) });

  assert.match(s.button().textContent, /button\.noSpace$/);
  assert.ok(isDisabled(s.button()));
  const needed = (dictationNeed / 1e9).toFixed(1);
  const free = (availableBytes / 1e9).toFixed(1);
  assert.equal(s.foot(), `${K}foot.noSpaceMac {"needed":"${needed}","free":"${free}"}`);
  assert.ok(s.container.textContent.includes(`${K}computer.mac`), "a Mac with no name");
  await s.click(s.button());
  assert.deepEqual(s.calls.parakeet, []);
});

test("models already on disk show ticks and Proceed straight away", async (t) => {
  const s = await mount(t, { onDisk: { parakeet: [DICTATION], llm: [CLEANUP, ASSISTANT] } });
  assert.match(s.button().textContent, /button\.proceed$/);
  assert.equal(isDisabled(s.button()), false);
  assert.equal(ticks(s.container).length, 3);
  await s.click(s.button());
  assert.deepEqual(s.proceeded, [BOTH_ON]);
  assert.deepEqual([s.calls.parakeet, s.calls.llm], [[], []]);
});

test("returning with models on disk: the assistant fits in what is left", async (t) => {
  const probe = await planFor();
  // Room for the assistant, not for all three: only what is missing counts.
  const availableBytes = bytesOf(probe, "assistant") * 1.2 + 0.2e9;
  const s = await mount(t, { availableBytes, onDisk: { parakeet: [DICTATION], llm: [CLEANUP] } });

  assert.equal(s.switchOf("assistant").attributes["aria-checked"], "true");
  assert.ok(!s.row("assistant").textContent.includes(`${K}line.offToFit`));
  assert.equal(s.foot(), `${K}foot.default`);
  assert.match(s.button().textContent, /button\.download$/);
  assert.equal(ticks(s.row("dictation")).length + ticks(s.row("cleanup")).length, 2);

  await s.click(s.button());
  assert.deepEqual([s.calls.parakeet, s.calls.llm], [[], [ASSISTANT]]);
});

test("returning with cleanup on disk and little space keeps cleanup on", async (t) => {
  const s = await mount(t, {
    availableBytes: 0.1e9,
    onDisk: { parakeet: [DICTATION], llm: [CLEANUP] },
  });

  assert.equal(s.switchOf("cleanup").attributes["aria-checked"], "true", "never trimmed");
  assert.equal(ticks(s.row("cleanup")).length, 1, "and shows its tick");
  assert.ok(!s.row("cleanup").textContent.includes(`${K}line.offToFit`));
  assert.equal(s.switchOf("assistant").attributes["aria-checked"], "false");
  assert.ok(s.row("assistant").textContent.includes(`${K}line.offToFit`));
  assert.match(s.button().textContent, /button\.proceed$/);
  await s.click(s.button());
  assert.deepEqual(s.proceeded, [{ cleanup: true, assistant: false }]);
});

test("unmount cancels the active item and starts nothing else", async (t) => {
  const s = await mount(t);
  await s.click(s.button());
  assert.deepEqual(s.calls.parakeet, [DICTATION]);
  await s.unmount();
  assert.equal(s.calls.cancelParakeet, 1);
  assert.deepEqual(s.calls.llm, []);
  assert.equal(s.calls.vulkan, 0);
});

test("Back keeps the tray claim until the transfer settles, so late errors stay out", async (t) => {
  const s = await mount(t);
  await s.click(s.button());
  await s.unmount();
  const claimed = (now) => s.claims.isLocalSetupDownload("parakeet", DICTATION, now);
  // The cancel can't stop an archive mid-unpack; the transfer is still main's.
  assert.equal(claimed(Date.now() + 60_000), true, "claimed while the transfer runs on");

  await s.finish(DICTATION, { success: false, code: "EXTRACTION_FAILED", error: "bad archive" });
  assert.equal(claimed(Date.now()), true, "its last chunks still arrive");
  assert.equal(claimed(Date.now() + 60_000), false, "released once it settled");
});

test("Retry, the pie and the tick name what they show", async (t) => {
  const s = await mount(t);
  await s.click(s.button());
  const [pie] = elements(s.row("dictation"), (n) => n.attributes.role === "progressbar");
  assert.ok(pie, "the pie is a progress bar");
  assert.equal(pie.attributes["aria-label"], `${K}rows.dictation`);
  assert.equal(pie.attributes["aria-valuemin"], "0");
  assert.equal(pie.attributes["aria-valuemax"], "100");

  await s.finish(DICTATION);
  const [tick] = ticks(s.row("dictation"));
  assert.equal(tick.attributes.role, "img");
  assert.equal(tick.attributes["aria-label"], `${K}downloaded`);

  await s.finish(CLEANUP, { success: false, error: "network down", code: "NETWORK" });
  const [retry] = elements(
    s.row("cleanup"),
    (n) => n.localName === "button" && n.textContent === `${K}retry`
  );
  assert.equal(retry.attributes["aria-label"], `${K}retryRow {"row":"${K}rows.cleanup"}`);
});

test("an organisation-required speech model shows its line and no speed badge", async (t) => {
  const s = await mount(t, { requiredSpeechModelId: "parakeet-tdt-0.6b-v3" });
  const row = s.row("dictation");
  assert.ok(row.textContent.includes(`${K}line.requiredByOrganization`));
  assert.ok(!row.textContent.includes(`${K}badge.`), row.textContent);
});

test("memory that couldn't be read leaves only the Not enough memory heading", async (t) => {
  const s = await mount(t, { profile: mac({ memoryGb: 0, appleChip: null }) });
  for (const id of ["cleanup", "assistant"]) {
    const text = s.row(id).textContent;
    assert.ok(text.includes(`${K}unavailable.notEnoughMemory`), id);
    assert.ok(!text.includes(`${K}unavailable.memoryMac`), `${id} never says it has 0 GB`);
  }
});

test("a cleanup too slow for this computer quotes its whole seconds", async (t) => {
  const tooSlow = (row) =>
    row.id !== "cleanup"
      ? row
      : {
          ...row,
          label: "unavailable",
          reason: "tooSlow",
          line: { key: "tooSlowCleanupSeconds", model: row.modelName, seconds: 12.4 },
        };
  const s = await mount(t, { mapPlan: (p) => ({ ...p, rows: p.rows.map(tooSlow) }) });
  const text = s.row("cleanup").textContent;
  assert.ok(text.includes(`${K}unavailable.tooSlow`));
  assert.ok(
    text.includes(`${K}unavailable.tooSlowCleanupSeconds {"model":"Qwen3.5 2B","seconds":12}`),
    text
  );
  assert.equal(s.switchOf("cleanup"), undefined);
});

test("a row turned off to fit keeps its line when the other switch is flipped", async (t) => {
  const probe = await planFor();
  const need = bytesOf(probe, "dictation") * 2.5 + bytesOf(probe, "cleanup") * 1.2;
  const s = await mount(t, { availableBytes: need + 0.2e9 });
  assert.ok(s.row("assistant").textContent.includes(`${K}line.offToFit`));

  await s.click(s.switchOf("cleanup"));
  assert.equal(s.switchOf("assistant").attributes["aria-checked"], "false");
  assert.ok(s.row("assistant").textContent.includes(`${K}line.offToFit`), "still off to fit");
  assert.ok(s.row("cleanup").textContent.includes(`${K}line.off`));
  assert.ok(!s.row("cleanup").textContent.includes(`${K}line.offToFit`), "the user's own off");
});

test("nothing is turned off to fit before the inventory has loaded", async (t) => {
  const probe = await planFor();
  // Room for the assistant only once dictation and cleanup are known to be on disk.
  const s = await mount(t, {
    availableBytes: bytesOf(probe, "assistant") * 1.2 + 0.2e9,
    onDisk: { parakeet: [DICTATION], llm: [CLEANUP] },
    holdInventory: true,
  });
  assert.equal(s.switchOf("assistant").attributes["aria-checked"], "true", "no frame of auto-off");
  assert.ok(!s.row("assistant").textContent.includes(`${K}line.offToFit`));

  await s.releaseInventory();
  assert.equal(s.switchOf("assistant").attributes["aria-checked"], "true");
  assert.equal(ticks(s.row("dictation")).length + ticks(s.row("cleanup")).length, 2);
});

test("NVIDIA cleanup row size includes the graphics pack, which is never named", async (t) => {
  const profile = pc({
    formFactor: "desktop",
    memoryGb: 32,
    nvidia: rtx,
    graphicsName: rtx.name,
    processorName: "AMD Ryzen 7 7700",
  });
  // The real pack (~39 MB) rounds away inside "1.3 GB"; a bigger one shows where it lands.
  const s = await mount(t, {
    profile,
    spokenLanguages: ["de"],
    mapPlan: (p) => ({ ...p, graphicsPack: p.graphicsPack && { ...p.graphicsPack, bytes: 5e8 } }),
  });
  assert.ok(s.plan.graphicsPack, "an NVIDIA plan carries the pack");
  const cleanup = s.plan.rows.find((r) => r.id === "cleanup");
  const assistant = s.plan.rows.find((r) => r.id === "assistant");
  const withPack = s.setup.rowSizeLabel(cleanup, s.plan.graphicsPack);
  assert.notEqual(withPack, s.setup.rowSizeLabel(cleanup, null));
  assert.ok(s.row("cleanup").textContent.includes(withPack), s.row("cleanup").textContent);
  assert.ok(s.row("assistant").textContent.includes(s.setup.rowSizeLabel(assistant, null)));
  assert.doesNotMatch(s.container.textContent, /vulkan|graphics pack/i);
  assert.ok(s.container.textContent.includes(`${K}computer.windowsDesktop`));
  assert.ok(s.container.textContent.includes("German"));

  // Cleanup off: the pack moves to the assistant row, with its size.
  await s.click(s.switchOf("cleanup"));
  assert.ok(
    s.row("assistant").textContent.includes(
      s.setup.rowSizeLabel(assistant, s.plan.graphicsPack)
    )
  );
  assert.ok(s.row("cleanup").textContent.includes(s.setup.rowSizeLabel(cleanup, null)));
});

test("the placeholder holds the card's frame and can say the policy didn't load", async (t) => {
  const s = await mount(t);
  const rowHeights = new Set(
    elements(s.container, (n) => n.attributes["data-local-setup-row"] != null).map((n) =>
      cls(n).match(/\bh-\d+\b/)?.[0]
    )
  );
  assert.deepEqual([...rowHeights], ["h-24"], "the real rows are h-24");
  await s.unmount();

  const { LocalSetupStepPlaceholder } = s.step;
  const render = async (props) => {
    const root = createRoot(s.container);
    await React.act(async () => root.render(React.createElement(LocalSetupStepPlaceholder, props)));
    const [card] = elements(s.container, (n) => n.localName === "section");
    const html = { busy: card.attributes["aria-busy"], text: card.textContent, card };
    await React.act(async () => root.unmount());
    return html;
  };

  const loading = await render({});
  assert.equal(loading.busy, "true");
  // Three h-24 rows (18rem), the two borders between them and the panel's two.
  const [rowsPanel] = elements(loading.card, (n) => cls(n).includes("h-[calc(18rem+4px)]"));
  assert.ok(rowsPanel, "the rows' panel is as tall as three rows");
  assert.equal(loading.text.trim().replace(/\u00a0/g, ""), "");

  const failed = await render({ message: "common.policyUnresolved" });
  assert.equal(failed.busy, undefined);
  assert.equal(failed.text.replace(/\u00a0/g, "").trim(), "common.policyUnresolved");
});

test("header helpers name the computer and join the languages", async (t) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-local-setup-helpers-test-",
  });
  const step = await vite.ssrLoadModule("/components/onboarding/localSetupLabels.ts");
  const t1 = (key) => key;
  assert.equal(step.localSetupComputerName(mac(), t1), "MacBook Pro");
  assert.equal(step.localSetupComputerName(mac({ name: null }), t1), `${K}computer.mac`);
  assert.equal(step.localSetupComputerName(pc(), t1), `${K}computer.windowsLaptop`);
  assert.equal(
    step.localSetupComputerName(pc({ platform: "linux", formFactor: "desktop" }), t1),
    `${K}computer.linuxDesktop`
  );
  assert.equal(step.localSetupLanguageLabel(["en"], "en"), "English");
  assert.equal(step.localSetupLanguageLabel(["es", "ja"], "en"), "Spanish and Japanese");
  assert.equal(
    step.localSetupLanguageLabel(["en", "de", "fr"], "en"),
    "English, German, and French"
  );
  assert.equal(step.formatLocalSetupSeconds([1.6, 2.7]), "2–3");
  assert.equal(step.formatLocalSetupSeconds([4.8, 4.8]), "5");
  assert.equal(step.formatLocalSetupSeconds([2.4, 2.6]), "2–3");
  assert.equal(step.formatLocalSetupSeconds([2.6, 3.4]), "3");
});
