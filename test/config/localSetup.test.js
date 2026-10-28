const test = require("node:test");
const assert = require("node:assert/strict");

const registry = require("../../src/models/modelRegistryData.json");
const languageRegistry = require("../../src/config/languageRegistry.json");
const table = require("../../src/models/localSetupTable.json");

const load = () => import("../../src/config/localSetup.ts");

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

const UNMANAGED = { status: "unmanaged", policy: null, appVersion: null };
const managed = ({ llmModes = ["openwhispr", "local"], agentEnabled = true } = {}) => ({
  status: "managed",
  appVersion: "1.0.0",
  policy: {
    version: 1,
    transcription: { allowedModes: ["openwhispr", "local"], allowedByokProviders: [] },
    llm: { allowedModes: llmModes, allowedByokProviders: [], allowedEnterpriseProviders: [] },
    features: { agentEnabled, webSearchEnabled: true },
    sharing: { externalLinkSharing: "allowed" },
    dataRetention: {
      audioRetentionMaxDays: null,
      localHistoryMode: "user_choice",
      cloudBackupAllowed: true,
    },
    minAppVersion: null,
  },
});

async function plan(profile, extra = {}) {
  const { buildLocalSetupPlan } = await load();
  return buildLocalSetupPlan({
    profile,
    spokenLanguages: ["en-US"],
    policy: UNMANAGED,
    ...extra,
  });
}
const row = (p, id) => p.rows.find((r) => r.id === id);
const labels = (p) => p.rows.map((r) => r.label);

test("classifies the §8 machine types", async () => {
  const { classifyMachine } = await load();
  const c = classifyMachine;
  assert.equal(c(mac({})), "mac-m5-pro");
  assert.equal(c(mac({ memoryGb: 24 })), "mac-m5-pro"); // by chip, not memory band
  assert.equal(c(mac({ appleChip: { generation: 4, tier: "Pro" } })), "mac-m4-pro");
  assert.equal(c(mac({ appleChip: { generation: 2, tier: "" }, memoryGb: 64 })), "mac-m2");
  assert.equal(c(mac({ appleChip: { generation: 4, tier: "Max" } })), "mac-m4-max");
  // an Ultra takes its generation's Max row
  assert.equal(c(mac({ appleChip: { generation: 2, tier: "Ultra" } })), "mac-m2-max");
  // a chip not in the table yet takes the newest listed one of its tier
  assert.equal(c(mac({ appleChip: { generation: 6, tier: "" } })), "mac-m5");
  assert.equal(c(mac({ appleChip: { generation: 7, tier: "Max" } })), "mac-m5-max");
  assert.equal(c(mac({ appleChip: { generation: 6, tier: "Ultra" } })), "mac-m5-max");
  // a tier the table doesn't know
  assert.equal(c(mac({ appleChip: { generation: 4, tier: "Nano" } })), "mac-16-plus");
  assert.equal(c(mac({ appleChip: { generation: 1, tier: "" }, memoryGb: 8 })), "mac-under-16");
  // Intel Mac
  assert.equal(c(mac({ arch: "x64", appleChip: null, memoryGb: 16 })), "pc-16-plus");
  assert.equal(c(pc({ memoryGb: 8 })), "pc-under-16");
  assert.equal(c(pc({ nvidia: rtx })), "pc-nvidia");
  assert.equal(c(pc({ nvidia: { name: "NVIDIA GeForce MX450", vramMb: 2048 } })), "pc-16-plus");
  const gtx = { name: "NVIDIA GeForce GTX 1650", vramMb: null };
  assert.equal(c(pc({ memoryGb: 8, nvidia: gtx })), "pc-under-16");
  const linux = pc({ platform: "linux", nvidia: { name: "RTX 3080", vramMb: 10240 } });
  assert.equal(c(linux), "pc-nvidia");
});

test("language pick follows design §6.2 and call 4", async () => {
  const { pickDictationModel } = await load();
  const m = (langs, p = mac({})) => pickDictationModel(langs, p).modelId;
  assert.equal(m(["en-US"]), "parakeet-unified-en-0.6b");
  assert.equal(m(["en-GB", "de"]), "orukeet-v0.1.0");
  assert.equal(m(["pt-BR"]), "orukeet-v0.1.0");
  assert.equal(m(["hi"]), "nemotron-3.5-asr-streaming-0.6b");
  assert.equal(m(["hi", "en-US"]), "nemotron-3.5-asr-streaming-0.6b");
  assert.equal(m(["hi", "fr"]), "small");
  assert.equal(m(["es", "ja"]), "small");
  assert.equal(m(["zh-TW"]), "small");
  assert.equal(m(["nb"]), "small"); // Norwegian: whisper yes, Orukeet no
  assert.equal(m([]), "parakeet-unified-en-0.6b");
  assert.equal(m(["auto"]), "parakeet-unified-en-0.6b");
  // a language no local model knows goes to Whisper, never the English-only model
  assert.equal(m(["xx-unsupported"]), "small");
  assert.equal(m(["yue"]), "small");
  assert.equal(m(["fil-PH"]), "small"); // Filipino is Whisper's Tagalog
  // macOS before 15.5
  assert.equal(m(["en-US"], mac({ parakeetSupported: false })), "small");
  assert.equal(pickDictationModel(["en-US"], mac({ parakeetSupported: false })).group, "olderMac");
  assert.equal(pickDictationModel(["en-GB", "de"], mac({})).group, "european");
});

test("never offers a model for a language it lacks", async () => {
  const { pickDictationModel } = await load();
  const englishFallback = table.models.dictation.english;
  for (const { code, whisper } of languageRegistry.languages) {
    if (code === "auto") continue;
    const base = code.split("-")[0].toLowerCase();
    const { modelId } = pickDictationModel([code], mac({}));
    const parakeet = registry.parakeetModels[modelId];
    const ok =
      (parakeet && (parakeet.supportedLanguages || []).includes(base)) ||
      (registry.whisperModels[modelId] && whisper === true) ||
      modelId === englishFallback;
    assert.ok(ok, `${code} → ${modelId}`);
    // The English fallback is only used for English or a language nothing local supports.
    if (modelId === englishFallback && base !== "en") {
      assert.equal(whisper, false, `${code} fell back to English but Whisper supports it`);
      const european = registry.parakeetModels[table.models.dictation.european];
      assert.ok(!european.supportedLanguages.includes(base), `${code} is in Orukeet's list`);
    }
  }
});

test("each table machine gets its table labels", async () => {
  const cases = [
    [pc({ memoryGb: 8 }), "pc-under-16", ["fast", "slower", "unavailable"], "tooSlow"],
    [pc({}), "pc-16-plus", ["fast", "slower", "unavailable"], "tooSlow"],
    [pc({ nvidia: rtx }), "pc-nvidia", ["fast", "fast", "slower"], undefined],
    [mac({ memoryGb: 8 }), "mac-under-16", ["fast", "unavailable", "unavailable"], "memory"],
    [mac({ appleChip: null }), "mac-16-plus", ["fast", "slower", "unavailable"], "tooSlow"],
    [mac({}), "mac-m5-pro", ["fast", "fast", "slower"], undefined],
    [mac({ appleChip: { generation: 1, tier: "" } }), "mac-m1", ["fast", "slower", "unavailable"]],
    [
      mac({ appleChip: { generation: 4, tier: "Pro" } }),
      "mac-m4-pro",
      ["fast", "fast", "unavailable"],
    ],
    [mac({ appleChip: { generation: 5, tier: "" } }), "mac-m5", ["fast", "fast", "slower"]],
    [mac({ appleChip: { generation: 5, tier: "Max" } }), "mac-m5-max", ["fast", "fast", "slower"]],
  ];
  for (const [profile, machineType, expected, assistantReason] of cases) {
    const p = await plan(profile);
    assert.equal(p.machineType, machineType);
    assert.deepEqual(labels(p), expected, machineType);
    if (assistantReason) assert.equal(row(p, "assistant").reason, assistantReason, machineType);
    if (machineType !== "pc-nvidia") assert.equal(p.graphicsPack, null, machineType);
  }
  assert.deepEqual((await plan(pc({ nvidia: rtx }))).graphicsPack, {
    kind: "llamaVulkan",
    id: "llama-vulkan",
    bytes: table.graphicsPackBytes["win32-x64"],
  });
  const linux = await plan(pc({ platform: "linux", nvidia: rtx }));
  assert.equal(linux.graphicsPack.bytes, table.graphicsPackBytes["linux-x64"]);
});

test("rows follow memory needs on top of the table, per platform", async () => {
  const mac8 = await plan(mac({ memoryGb: 8 }));
  assert.equal(row(mac8, "cleanup").reason, "memory");
  assert.equal(row(mac8, "assistant").reason, "memory");
  assert.deepEqual(row(mac8, "cleanup").line, {
    key: "notEnoughMemory",
    model: "Qwen3.5 2B",
    neededGb: 16,
    haveGb: 8,
  });
  const { enabledDownloads } = await load();
  const mac8Downloads = enabledDownloads(mac8, { cleanup: true, assistant: true });
  assert.deepEqual(
    mac8Downloads.map((d) => d.rowId),
    ["dictation"]
  );

  const pc8 = await plan(pc({ memoryGb: 8 }));
  assert.equal(row(pc8, "cleanup").label, "slower");

  const nvidia8 = await plan(pc({ memoryGb: 8, nvidia: rtx }));
  assert.equal(nvidia8.machineType, "pc-nvidia");
  assert.equal(row(nvidia8, "assistant").label, "unavailable");
  assert.equal(row(nvidia8, "assistant").reason, "memory");
  assert.equal(row(nvidia8, "assistant").line.neededGb, 16);

  const pc6 = await plan(pc({ memoryGb: 6 }));
  assert.equal(row(pc6, "cleanup").reason, "memory");
  assert.equal(row(pc6, "cleanup").line.neededGb, 8);
  assert.equal(row(pc6, "cleanup").line.haveGb, 6);

  const intelMac8 = await plan(mac({ arch: "x64", appleChip: null, memoryGb: 8 }));
  assert.equal(intelMac8.machineType, "pc-under-16");
  assert.equal(row(intelMac8, "cleanup").reason, "memory");
  assert.equal(row(intelMac8, "cleanup").line.neededGb, 16);
});

test("Whisper Small on a PC reads slower, other languages on a Mac don't", async () => {
  const ja = { spokenLanguages: ["ja"] };
  const pcJa = row(await plan(pc({}), ja), "dictation");
  assert.equal(pcJa.modelId, "small");
  assert.equal(pcJa.label, "slower");
  assert.deepEqual(pcJa.line, { key: "dictationSeconds", range: [3, 4] });
  assert.equal(row(await plan(pc({})), "dictation").label, "fast");
  const macJa = row(await plan(mac({ appleChip: null }), ja), "dictation");
  assert.equal(macJa.label, "fast");
});

test("lines are built from the table", async () => {
  const m5 = await plan(mac({}));
  assert.deepEqual(row(m5, "dictation").line, { key: "dictationSeconds", range: [2, 2] });
  assert.deepEqual(row(m5, "cleanup").line, { key: "cleanupUnderSecond" });
  assert.deepEqual(row(m5, "assistant").line, { key: "assistantSeconds", range: [4.8, 4.8] });

  assert.deepEqual(row(await plan(pc({})), "assistant").line, {
    key: "tooSlowMinutes",
    model: "Qwen3.5 4B",
    minutes: 3,
  });

  const cautious = await plan(mac({ appleChip: null }));
  assert.deepEqual(row(cautious, "assistant").line, {
    key: "tooSlowAboutMinute",
    model: "Qwen3.5 4B",
  });
  assert.deepEqual(row(cautious, "cleanup").line, { key: "cleanupAddsSeconds", range: [1.6, 2.7] });

  const m4pro = await plan(mac({ appleChip: { generation: 4, tier: "Pro" } }));
  assert.deepEqual(row(m4pro, "assistant").line, {
    key: "tooSlowAssistantSeconds",
    model: "Qwen3.5 4B",
    range: [14, 17],
  });
  const m1 = await plan(mac({ appleChip: { generation: 1, tier: "" } }));
  assert.deepEqual(row(m1, "assistant").line, { key: "tooSlowAboutMinute", model: "Qwen3.5 4B" });
  const m4max = await plan(mac({ appleChip: { generation: 4, tier: "Max" } }));
  assert.deepEqual(row(m4max, "assistant").line, { key: "assistantSeconds", range: [7, 9] });

  const older = row(await plan(mac({ parakeetSupported: false })), "dictation");
  assert.equal(older.modelId, "small");
  assert.equal(older.label, "slower");
  assert.deepEqual(older.line, { key: "dictationFewSeconds" });
});

test("rows carry the registry name, icon and download", async () => {
  const p = await plan(mac({}), { spokenLanguages: ["de"] });
  const dictation = row(p, "dictation");
  assert.equal(dictation.modelId, "orukeet-v0.1.0");
  assert.equal(dictation.modelName, "Orukeet");
  assert.equal(dictation.providerIcon, "oruk");
  assert.deepEqual(dictation.download, {
    kind: "parakeet",
    id: "orukeet-v0.1.0",
    bytes: registry.parakeetModels["orukeet-v0.1.0"].expectedSizeBytes,
  });
  const en = row(await plan(mac({})), "dictation");
  assert.equal(en.providerIcon, "nvidia");
  assert.equal(en.download.bytes, registry.parakeetModels["parakeet-unified-en-0.6b"].sizeMb * 1e6);
  const whisper = row(await plan(mac({ parakeetSupported: false })), "dictation");
  assert.equal(whisper.providerIcon, "openai");
  assert.equal(whisper.download.kind, "whisper");
  assert.equal(whisper.download.bytes, registry.whisperModels.small.expectedSizeBytes);
  const cleanup = row(p, "cleanup");
  assert.equal(cleanup.providerIcon, "qwen");
  assert.deepEqual(cleanup.download, {
    kind: "llm",
    id: "qwen3.5-2b-q4_k_m",
    bytes: 1329766560,
  });
  assert.deepEqual(
    p.rows.map((r) => r.id),
    ["dictation", "cleanup", "assistant"]
  );
});

test("languages fall back to the system language", async () => {
  const guest = await plan(mac({ systemLanguage: "cy" }), { spokenLanguages: [] });
  assert.deepEqual(guest.languages, ["cy"]);
  assert.equal(row(guest, "dictation").modelId, "small");
  const spoken = await plan(mac({ systemLanguage: "cy" }), { spokenLanguages: ["pt-BR", "auto"] });
  assert.deepEqual(spoken.languages, ["pt"]);
  assert.equal(row(spoken, "dictation").modelId, "orukeet-v0.1.0");
});

test("policy hides rows", async () => {
  const noLocalLlm = await plan(mac({}), { policy: managed({ llmModes: ["openwhispr"] }) });
  assert.deepEqual(
    noLocalLlm.rows.map((r) => r.id),
    ["dictation"]
  );
  const noAgent = await plan(mac({}), { policy: managed({ agentEnabled: false }) });
  assert.deepEqual(
    noAgent.rows.map((r) => r.id),
    ["dictation", "cleanup"]
  );
  const allowed = await plan(mac({}), { policy: managed() });
  assert.deepEqual(
    allowed.rows.map((r) => r.id),
    ["dictation", "cleanup", "assistant"]
  );
});

test("an organisation-required speech model replaces the pick", async () => {
  const p = await plan(mac({}), { requiredSpeechModelId: "parakeet-tdt-0.6b-v3" });
  const dictation = row(p, "dictation");
  assert.equal(dictation.modelId, "parakeet-tdt-0.6b-v3");
  assert.equal(dictation.modelName, "Parakeet TDT 0.6B");
  assert.equal(dictation.label, null);
  assert.deepEqual(dictation.line, { key: "requiredByOrganization" });
  assert.equal(dictation.download.kind, "parakeet");
  const unknown = row(await plan(mac({}), { requiredSpeechModelId: "not-a-model" }), "dictation");
  assert.equal(unknown.modelId, "parakeet-unified-en-0.6b");
  const whisper = row(await plan(pc({}), { requiredSpeechModelId: "base" }), "dictation");
  assert.equal(whisper.download.kind, "whisper");
  assert.equal(whisper.providerIcon, "openai");
});

test("unknown and partial profiles take the cautious row", async () => {
  const { classifyMachine } = await load();
  const unread = mac({ processorName: "", appleChip: null });
  assert.equal(classifyMachine(unread), "mac-16-plus");
  assert.equal(classifyMachine({ ...unread, memoryGb: 8 }), "mac-under-16");
  assert.equal(classifyMachine({ ...unread, memoryGb: 0 }), "mac-under-16");
  const intel = mac({ arch: "x64", processorName: "", appleChip: null });
  assert.equal(classifyMachine(intel), "pc-16-plus");
  assert.equal(classifyMachine(pc({ memoryGb: 0 })), "pc-under-16");
  const blank = pc({ memoryGb: 0, processorName: "", graphicsName: null });
  assert.equal(classifyMachine(blank), "pc-under-16");
  const p = await plan(pc({ memoryGb: 0 }));
  assert.equal(row(p, "cleanup").reason, "memory");
  assert.equal(row(p, "assistant").reason, "tooSlow");
});

test("sizes match what Settings shows", async () => {
  const { rowSizeLabel } = await load();
  const size = async (profile, langs) =>
    rowSizeLabel(row(await plan(profile, { spokenLanguages: langs }), "dictation"), null);
  assert.equal(await size(mac({}), ["en-US"]), "631 MB");
  assert.equal(await size(mac({}), ["de"]), "464 MB");
  assert.equal(await size(mac({}), ["ja"]), "466 MB");
  assert.equal(await size(mac({}), ["hi"]), "650 MB");
  const p = await plan(pc({ nvidia: rtx }));
  assert.equal(rowSizeLabel(row(p, "cleanup"), null), "1.3 GB");
  assert.equal(rowSizeLabel(row(p, "assistant"), null), "2.7 GB");
  assert.equal(rowSizeLabel(row(p, "cleanup"), p.graphicsPack), "1.3 GB");
  // The real pack hides in the rounding; a larger one shows it is folded in.
  const bigPack = { ...p.graphicsPack, bytes: 0.5 * 2 ** 30 };
  assert.equal(rowSizeLabel(row(p, "cleanup"), bigPack), "1.7 GB");
});

test("speech picks quote their downloaded file", () => {
  const picks = new Set(Object.values(table.models.dictation));
  for (const id of picks) {
    const model = registry.parakeetModels[id] || registry.whisperModels[id];
    assert.ok(model, id);
    if (!model.expectedSizeBytes) continue;
    const quotedMb = parseFloat(model.size) * (/GB/.test(model.size) ? 1024 : 1);
    const fileMb = model.expectedSizeBytes / 2 ** 20;
    assert.ok(Math.abs(quotedMb - fileMb) / fileMb < 0.02, `${id}: ${model.size} vs ${fileMb}`);
  }
});

test("enabledDownloads folds the graphics pack into the first switched-on text row", async () => {
  const { enabledDownloads } = await load();
  const p = await plan(pc({ nvidia: rtx }));
  const ids = (d) => d.map(({ rowId, items }) => [rowId, items.map((i) => i.id)]);
  const parakeet = ["dictation", ["parakeet-unified-en-0.6b"]];
  assert.deepEqual(ids(enabledDownloads(p, { cleanup: true, assistant: true })), [
    parakeet,
    ["cleanup", ["qwen3.5-2b-q4_k_m", "llama-vulkan"]],
    ["assistant", ["qwen3.5-4b-q4_k_m"]],
  ]);
  assert.deepEqual(ids(enabledDownloads(p, { cleanup: false, assistant: true })), [
    parakeet,
    ["assistant", ["qwen3.5-4b-q4_k_m", "llama-vulkan"]],
  ]);
  assert.deepEqual(ids(enabledDownloads(p, { cleanup: false, assistant: false })), [parakeet]);

  // Unavailable rows never appear, and never carry the pack.
  const slow = await plan(pc({}));
  assert.deepEqual(ids(enabledDownloads(slow, { cleanup: true, assistant: true })), [
    parakeet,
    ["cleanup", ["qwen3.5-2b-q4_k_m"]],
  ]);
});

test("the table is complete and reachable", async () => {
  const llmIds = new Set(registry.localProviders.flatMap((p) => p.models.map((m) => m.id)));
  for (const id of Object.values(table.models.dictation)) {
    assert.ok(registry.parakeetModels[id] || registry.whisperModels[id], id);
  }
  assert.ok(llmIds.has(table.models.cleanup));
  assert.ok(llmIds.has(table.models.assistant));

  const LABELS = ["fast", "slower", "unavailable"];
  const GROUPS = ["english", "european", "hindi", "other"];
  const isRange = (r) =>
    Array.isArray(r) && r.length === 2 && typeof r[0] === "number" && r[0] >= 0;
  const checkEntry = (where, entry, rangeKey) => {
    assert.ok(LABELS.includes(entry.label), `${where} label`);
    // Dictation is the one row with no switch: it can never be unavailable.
    if (rangeKey === "seconds") assert.notEqual(entry.label, "unavailable", `${where} dictation`);
    if (entry.label === "unavailable") {
      assert.ok(["tooSlow", "memory"].includes(entry.reason), `${where} reason`);
      if (entry.reason === "memory") return;
    }
    const range = entry[rangeKey];
    assert.ok(isRange(range), `${where} ${rangeKey}`);
    // "or more" (high null) only reads as a too-slow line.
    if (range[1] === null) assert.equal(entry.label, "unavailable", `${where} open range`);
    else assert.ok(range[1] >= range[0], `${where} range order`);
  };

  for (const [key, machine] of Object.entries(table.machines)) {
    assert.ok(
      /^(pc-under-16|pc-16-plus|pc-nvidia|mac-under-16|mac-16-plus|mac-m\d+(-(pro|max))?)$/.test(
        key
      ),
      `${key} is reachable`
    );
    assert.ok(typeof machine.source === "string" && /^[MP]/.test(machine.source), `${key} source`);
    for (const group of GROUPS) checkEntry(`${key} ${group}`, machine.dictation[group], "seconds");
    checkEntry(`${key} cleanup`, machine.cleanup, "addedSeconds");
    checkEntry(`${key} assistant`, machine.assistant, "firstWordsSeconds");
    // A "memory" row must hold for every computer of the type: only an under-16 type,
    // whose memory stays below the band, and only where the band is at most the need.
    for (const rowId of ["cleanup", "assistant"]) {
      if (machine[rowId].reason !== "memory") continue;
      const neededGb = table.memoryNeededGb[rowId][key.startsWith("mac") ? "mac" : "pc"];
      assert.ok(key.endsWith("-under-16"), `${key} ${rowId} memory reason needs a memory ceiling`);
      assert.ok(table.classification.memoryBandGb <= neededGb, `${key} ${rowId} memory need`);
    }
  }
  for (const key of ["pc-under-16", "pc-16-plus", "pc-nvidia", "mac-under-16", "mac-16-plus"]) {
    assert.ok(table.machines[key], key);
  }
  for (const rowId of ["cleanup", "assistant"]) {
    const need = table.memoryNeededGb[rowId];
    assert.ok(need.mac > 0 && need.pc > 0, rowId);
  }
  for (const [key, bytes] of Object.entries(table.graphicsPackBytes)) {
    assert.ok(Number.isInteger(bytes) && bytes > 0, key);
  }
  assert.ok(LABELS.includes(table.olderMacDictation.label));
  assert.notEqual(table.olderMacDictation.label, "unavailable", "older Mac dictation");
  assert.deepEqual(Object.keys(table.graphicsPackBytes).sort(), ["linux-x64", "win32-x64"]);
  // The machine-type cut-offs live here too, never in code.
  assert.ok(Number.isInteger(table.classification.nvidiaMinVramMb), "nvidiaMinVramMb");
  assert.ok(table.classification.nvidiaMinVramMb > 0, "nvidiaMinVramMb");
  assert.ok(Number.isInteger(table.classification.memoryBandGb), "memoryBandGb");
  assert.ok(table.classification.memoryBandGb > 0, "memoryBandGb");
});

test("the machine-type cut-offs come from the table", async () => {
  const { classifyMachine } = await load();
  const { memoryBandGb, nvidiaMinVramMb } = table.classification;
  const card = (vramMb) => ({ name: "NVIDIA GeForce RTX", vramMb });
  assert.equal(classifyMachine(pc({ nvidia: card(nvidiaMinVramMb) })), "pc-nvidia");
  assert.equal(classifyMachine(pc({ nvidia: card(nvidiaMinVramMb - 1) })), "pc-16-plus");
  assert.equal(classifyMachine(pc({ memoryGb: memoryBandGb })), "pc-16-plus");
  assert.equal(classifyMachine(pc({ memoryGb: memoryBandGb - 1 })), "pc-under-16");
});

const GB = 1e9;
const factors = { whisper: 1.2, parakeet: 2.5, llm: 1.2, llamaVulkan: 1.5 };
const space = (gb) => ({ availableBytes: gb * GB, factors });
const llmBytes = (id) =>
  registry.localProviders.flatMap((p) => p.models).find((m) => m.id === id).sizeBytes;
// mac-m5-pro English: Parakeet EN 631 MB ×2.5, Qwen 2B ×1.2, Qwen 4B ×1.2 ≈ 6.62 GB in all.
const DICTATION_NEED = 631e6 * 2.5;
const CLEANUP_NEED = llmBytes("qwen3.5-2b-q4_k_m") * 1.2;
const ASSISTANT_NEED = llmBytes("qwen3.5-4b-q4_k_m") * 1.2;

test("required bytes apply each download's reserve factor", async () => {
  const { localSetupRequiredBytes, enabledDownloads } = await load();
  const p = await plan(mac({}));
  const items = enabledDownloads(p, { cleanup: true, assistant: true }).flatMap((r) => r.items);
  const total = DICTATION_NEED + CLEANUP_NEED + ASSISTANT_NEED;
  assert.ok(Math.abs(localSetupRequiredBytes(items, factors) - total) < 1);
  assert.ok(Math.abs(total / GB - 6.62) < 0.01);

  const nv = await plan(pc({ nvidia: rtx }));
  const nvItems = enabledDownloads(nv, { cleanup: true, assistant: false }).flatMap((r) => r.items);
  const nvNeed = DICTATION_NEED + CLEANUP_NEED + table.graphicsPackBytes["win32-x64"] * 1.5;
  assert.ok(Math.abs(localSetupRequiredBytes(nvItems, factors) - nvNeed) < 1);
  assert.equal(localSetupRequiredBytes([], factors), 0);
});

test("enough space changes nothing", async () => {
  const { fitLocalSetupToSpace } = await load();
  const p = await plan(mac({}));
  const fit = fitLocalSetupToSpace(p, {}, space(100));
  assert.deepEqual(fit.switches, { cleanup: true, assistant: true });
  assert.deepEqual(fit.autoOff, []);
  assert.equal(fit.state, "fits");
  assert.ok(Math.abs(fit.requiredBytes - (DICTATION_NEED + CLEANUP_NEED + ASSISTANT_NEED)) < 1);

  const infinite = fitLocalSetupToSpace(p, {}, { availableBytes: Infinity, factors });
  assert.equal(infinite.state, "fits");
  const userOff = fitLocalSetupToSpace(p, { cleanup: false }, space(100));
  assert.deepEqual(userOff.switches, { cleanup: false, assistant: true });
  assert.equal(userOff.state, "fits");
});

test("short space turns the assistant off first, then cleanup", async () => {
  const { fitLocalSetupToSpace } = await load();
  const p = await plan(mac({}));

  const four = fitLocalSetupToSpace(p, {}, space(4));
  assert.deepEqual(four.autoOff, ["assistant"]);
  assert.deepEqual(four.switches, { cleanup: true, assistant: false });
  assert.equal(four.state, "trimmed");
  assert.ok(Math.abs(four.requiredBytes - (DICTATION_NEED + CLEANUP_NEED)) < 1);

  const two = fitLocalSetupToSpace(p, {}, space(2));
  assert.deepEqual(two.autoOff, ["assistant", "cleanup"]);
  assert.deepEqual(two.switches, { cleanup: false, assistant: false });
  assert.equal(two.state, "trimmed");
  assert.ok(Math.abs(two.requiredBytes - DICTATION_NEED) < 1);

  // A row the computer can't run is never "turned off to fit".
  const pc16 = await plan(pc({}));
  assert.equal(row(pc16, "assistant").label, "unavailable");
  const pcTwo = fitLocalSetupToSpace(pc16, {}, space(2));
  assert.deepEqual(pcTwo.autoOff, ["cleanup"]);
  assert.equal(pcTwo.state, "trimmed");

  // A row the user switched off stays off and is not reported as trimmed.
  const userOff = fitLocalSetupToSpace(p, { cleanup: false }, space(4));
  assert.deepEqual(userOff.switches, { cleanup: false, assistant: false });
  assert.deepEqual(userOff.autoOff, ["assistant"]);
});

test("dictation alone not fitting is noSpace", async () => {
  const { fitLocalSetupToSpace } = await load();
  const p = await plan(mac({}));
  const fit = fitLocalSetupToSpace(p, {}, space(1.5));
  assert.equal(fit.state, "noSpace");
  assert.ok(Math.abs(fit.requiredBytes - DICTATION_NEED) < 1, "the foot line quotes dictation");
  assert.deepEqual(fit.switches, { cleanup: false, assistant: false });
  assert.deepEqual(fit.autoOff, ["assistant", "cleanup"]);
});

test("switching an auto-off row back on overflows", async () => {
  const { fitLocalSetupToSpace } = await load();
  const p = await plan(mac({}));
  assert.deepEqual(fitLocalSetupToSpace(p, {}, space(4)).autoOff, ["assistant"]);

  // The user's own switch is kept: the button stops working instead of re-trimming.
  const back = fitLocalSetupToSpace(p, { assistant: true }, space(4));
  assert.equal(back.state, "overflow");
  // Turning cleanup off would still not fit, so it is left on rather than trimmed for nothing.
  assert.deepEqual(back.switches, { cleanup: true, assistant: true });
  assert.deepEqual(back.autoOff, []);
  assert.ok(Math.abs(back.requiredBytes - (DICTATION_NEED + CLEANUP_NEED + ASSISTANT_NEED)) < 1);

  const both = fitLocalSetupToSpace(p, { cleanup: true, assistant: true }, space(4));
  assert.equal(both.state, "overflow");
  assert.deepEqual(both.switches, { cleanup: true, assistant: true });
  assert.deepEqual(both.autoOff, []);
  assert.ok(Math.abs(both.requiredBytes - (DICTATION_NEED + CLEANUP_NEED + ASSISTANT_NEED)) < 1);
});

test("items already on disk cost nothing and their rows are never trimmed", async () => {
  const { fitLocalSetupToSpace } = await load();
  const p = await plan(mac({}));
  const has =
    (...ids) =>
    (item) =>
      ids.includes(item.id);
  const dictationAndCleanup = has(row(p, "dictation").modelId, row(p, "cleanup").modelId);

  // Back after two downloads: the assistant alone now fits where all three would not.
  const room = (ASSISTANT_NEED + 0.1 * GB) / GB;
  assert.equal(fitLocalSetupToSpace(p, {}, space(room)).state, "trimmed", "without the inventory");
  const fits = fitLocalSetupToSpace(p, {}, space(room), dictationAndCleanup);
  assert.equal(fits.state, "fits");
  assert.deepEqual(fits.switches, { cleanup: true, assistant: true });
  assert.ok(Math.abs(fits.requiredBytes - ASSISTANT_NEED) < 1);

  // Hardly any space: the downloaded cleanup row stays on, only the assistant goes.
  const tight = fitLocalSetupToSpace(p, {}, space(0.1), dictationAndCleanup);
  assert.equal(tight.state, "trimmed");
  assert.deepEqual(tight.switches, { cleanup: true, assistant: false });
  assert.deepEqual(tight.autoOff, ["assistant"]);
  assert.equal(tight.requiredBytes, 0);

  // Dictation on disk is never "noSpace".
  const noRoom = fitLocalSetupToSpace(p, {}, space(0), has(row(p, "dictation").modelId));
  assert.notEqual(noRoom.state, "noSpace");
  assert.deepEqual(noRoom.autoOff, ["assistant", "cleanup"]);

  // On NVIDIA a cleanup model on disk still needs its pack, so it can still be trimmed.
  const nv = await plan(pc({ nvidia: rtx }));
  const modelOnly = has(row(nv, "dictation").modelId, row(nv, "cleanup").modelId);
  const nvTight = fitLocalSetupToSpace(nv, {}, space(0.01), modelOnly);
  assert.deepEqual(nvTight.autoOff, ["assistant", "cleanup"]);
  const withPack = has(row(nv, "dictation").modelId, row(nv, "cleanup").modelId, "llama-vulkan");
  assert.deepEqual(fitLocalSetupToSpace(nv, {}, space(0.01), withPack).autoOff, ["assistant"]);
});
