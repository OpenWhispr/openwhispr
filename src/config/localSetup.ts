// Onboarding's "We recommend these settings" pick: which local models suit this
// computer and these languages, and how fast each will feel. Every number and
// label comes from localSetupTable.json; this module only looks them up.
import type { ComputerProfile } from "../types/electron";
import { isAgentAllowed, isModeAllowedByPolicy } from "../stores/policyRules";
import type { PolicyDecisionSnapshot } from "../stores/policyRules";
import { getASRModelOrganization } from "../helpers/localASROrganization";
import { formatBytes } from "../utils/formatBytes";
import modelRegistryData from "../models/modelRegistryData.json" with { type: "json" };
import languageRegistry from "./languageRegistry.json" with { type: "json" };
import localSetupTableData from "../models/localSetupTable.json" with { type: "json" };

export type LocalSetupRowId = "dictation" | "cleanup" | "assistant";
export type LocalSetupLabel = "fast" | "slower" | "unavailable";
export type MachineType =
  | "pc-under-16"
  | "pc-16-plus"
  | "pc-nvidia"
  | "mac-under-16"
  | "mac-16-plus" // the cautious row for unlisted or unread chips
  | `mac-m${number}` // base chip, e.g. "mac-m4"
  | `mac-m${number}-${"pro" | "max"}`; // e.g. "mac-m4-pro"; Ultra and unlisted tiers → mac-16-plus
export type LanguageGroup = "english" | "european" | "hindi" | "other";
export interface LocalSetupDownload {
  kind: "whisper" | "parakeet" | "llm" | "llamaVulkan";
  id: string;
  bytes: number;
}
export type LocalSetupLine =
  | { key: "dictationSeconds"; range: [number, number] }
  | { key: "dictationFewSeconds" }
  | { key: "cleanupUnderSecond" }
  | { key: "cleanupAddsSeconds"; range: [number, number] }
  | { key: "assistantSeconds"; range: [number, number] }
  | { key: "requiredByOrganization" }
  | { key: "tooSlowMinutes" | "tooSlowAboutMinute"; model: string; minutes?: number }
  | { key: "tooSlowCleanupSeconds"; model: string; seconds: number }
  | { key: "tooSlowAssistantSeconds"; model: string; range: [number, number] }
  | { key: "notEnoughMemory"; model: string; neededGb: number; haveGb: number };
export interface LocalSetupRow {
  id: LocalSetupRowId;
  modelId: string;
  modelName: string; // registry name, e.g. "Parakeet Unified EN 0.6B"
  providerIcon: string; // ProviderIcon id: "nvidia" | "oruk" | "openai" | "qwen"
  download: LocalSetupDownload;
  label: LocalSetupLabel | null; // null only for an organisation-required model
  reason?: "tooSlow" | "memory";
  line: LocalSetupLine;
}
export interface LocalSetupPlan {
  machineType: MachineType;
  profile: ComputerProfile;
  languages: string[]; // base codes the pick was made for
  rows: LocalSetupRow[]; // policy-hidden rows are absent; order dictation, cleanup, assistant
  graphicsPack: LocalSetupDownload | null;
}
export type LocalSetupSwitches = { cleanup: boolean; assistant: boolean };

// The shape of localSetupTable.json. `null` as a range's high end means "or more".
type Range = [number, number | null];
type UnavailableReason = "tooSlow" | "memory";
interface DictationEntry {
  label: LocalSetupLabel;
  seconds: Range | null;
}
interface MachineEntry {
  dictation: Record<LanguageGroup, DictationEntry>;
  cleanup: { label: LocalSetupLabel; reason?: UnavailableReason; addedSeconds: Range | null };
  assistant: {
    label: LocalSetupLabel;
    reason?: UnavailableReason;
    firstWordsSeconds: Range | null;
  };
  source: string;
}
interface LocalSetupTable {
  models: {
    dictation: Record<LanguageGroup | "olderMac", string>;
    cleanup: string;
    assistant: string;
  };
  memoryNeededGb: Record<"cleanup" | "assistant", { mac: number; pc: number }>;
  graphicsPackBytes: Record<string, number>;
  olderMacDictation: DictationEntry;
  machines: Record<string, MachineEntry>;
}

const table = localSetupTableData as unknown as LocalSetupTable;

interface SpeechModelInfo {
  name: string;
  size: string;
  sizeMb: number;
  expectedSizeBytes?: number;
  supportedLanguages?: string[];
}
interface TextModelInfo {
  id: string;
  name: string;
  size: string;
  sizeBytes: number;
}
const parakeetModels = modelRegistryData.parakeetModels as unknown as Record<
  string,
  SpeechModelInfo
>;
const whisperModels = modelRegistryData.whisperModels as unknown as Record<string, SpeechModelInfo>;
const textModels = new Map<string, { providerId: string; model: TextModelInfo }>();
for (const provider of modelRegistryData.localProviders) {
  for (const model of provider.models as TextModelInfo[]) {
    textModels.set(model.id, { providerId: provider.id, model });
  }
}

const MEMORY_BAND_GB = 16; // the "under-16" / "16-plus" split in the machine type names
const NVIDIA_MIN_VRAM_MB = 6000;

/** "631MB" → "631 MB", the registry size string as Settings shows it. */
export function spaceSizeUnit(size: string): string {
  return size.replace(/(?<=\d)(?=[A-Za-z])/, " ");
}

export function isAppleChipMac(profile: ComputerProfile): boolean {
  return profile.platform === "darwin" && (profile.appleChip != null || profile.arch === "arm64");
}

export function classifyMachine(profile: ComputerProfile): MachineType {
  if (isAppleChipMac(profile)) {
    if (!(profile.memoryGb >= MEMORY_BAND_GB)) return "mac-under-16";
    const chip = profile.appleChip;
    if (chip) {
      const tier = chip.tier === "Pro" ? "-pro" : chip.tier === "Max" ? "-max" : "";
      const key = `mac-m${chip.generation}${tier}`;
      if ((chip.tier === "" || tier) && table.machines[key]) return key as MachineType;
    }
    return "mac-16-plus";
  }
  const vramMb = profile.nvidia?.vramMb;
  if (vramMb != null && vramMb >= NVIDIA_MIN_VRAM_MB) return "pc-nvidia";
  return profile.memoryGb >= MEMORY_BAND_GB ? "pc-16-plus" : "pc-under-16";
}

// macOS reports Norwegian Bokmål as "nb"; the language list (and Whisper) call it "no".
const LANGUAGE_ALIASES: Record<string, string> = { nb: "no" };

function baseCode(code: string): string {
  const base = code.split("-")[0].toLowerCase();
  return LANGUAGE_ALIASES[base] ?? base;
}

function normalizeLanguages(codes: string[]): string[] {
  const out: string[] = [];
  for (const code of codes) {
    if (typeof code !== "string" || !code) continue;
    const base = baseCode(code);
    if (base !== "auto" && !out.includes(base)) out.push(base);
  }
  return out;
}

const whisperLanguages = new Set(
  languageRegistry.languages.filter((l) => l.whisper).map((l) => baseCode(l.code))
);
const europeanLanguages = new Set(
  parakeetModels[table.models.dictation.european]?.supportedLanguages ?? []
);

function languageGroup(languages: string[]): LanguageGroup {
  const known = languages.filter(
    (code) => europeanLanguages.has(code) || code === "hi" || whisperLanguages.has(code)
  );
  if (known.every((code) => code === "en")) return "english";
  if (known.includes("hi") && known.every((code) => code === "hi" || code === "en")) {
    return "hindi";
  }
  if (known.every((code) => europeanLanguages.has(code))) return "european";
  return "other";
}

export function pickDictationModel(
  languages: string[],
  profile: ComputerProfile
): { modelId: string; group: LanguageGroup | "olderMac" } {
  const group =
    profile.parakeetSupported === false ? "olderMac" : languageGroup(normalizeLanguages(languages));
  return { modelId: table.models.dictation[group], group };
}

function speechDownload(modelId: string): { download: LocalSetupDownload; info: SpeechModelInfo } {
  const parakeet = parakeetModels[modelId];
  const info = parakeet ?? whisperModels[modelId];
  return {
    info,
    download: {
      kind: parakeet ? "parakeet" : "whisper",
      id: modelId,
      bytes: info.expectedSizeBytes ?? info.sizeMb * 1e6,
    },
  };
}

function speechRowBase(modelId: string): Omit<LocalSetupRow, "label" | "line"> {
  const { download, info } = speechDownload(modelId);
  return {
    id: "dictation",
    modelId,
    modelName: info.name,
    providerIcon: download.kind === "parakeet" ? getASRModelOrganization(modelId) : "openai",
    download,
  };
}

function dictationRow(
  profile: ComputerProfile,
  machine: MachineEntry,
  languages: string[],
  requiredSpeechModelId?: string
): LocalSetupRow {
  // requiredLocalModelIds already drops ids this build can't download; the check keeps an
  // unknown id from reaching the registry lookups below.
  if (
    requiredSpeechModelId &&
    (parakeetModels[requiredSpeechModelId] || whisperModels[requiredSpeechModelId])
  ) {
    return {
      ...speechRowBase(requiredSpeechModelId),
      label: null,
      line: { key: "requiredByOrganization" },
    };
  }
  const { modelId, group } = pickDictationModel(languages, profile);
  const entry = group === "olderMac" ? table.olderMacDictation : machine.dictation[group];
  return {
    ...speechRowBase(modelId),
    label: entry.label,
    line: entry.seconds
      ? { key: "dictationSeconds", range: entry.seconds as [number, number] }
      : { key: "dictationFewSeconds" },
  };
}

function textRow(
  id: "cleanup" | "assistant",
  profile: ComputerProfile,
  machine: MachineEntry
): LocalSetupRow {
  const modelId = table.models[id];
  const { providerId, model } = textModels.get(modelId);
  const entry = machine[id];
  const range =
    id === "cleanup" ? machine.cleanup.addedSeconds : machine.assistant.firstWordsSeconds;
  const neededGb = table.memoryNeededGb[id][profile.platform === "darwin" ? "mac" : "pc"];

  let label = entry.label;
  let reason = label === "unavailable" ? entry.reason : undefined;
  if (label !== "unavailable" && !(profile.memoryGb >= neededGb)) {
    label = "unavailable";
    reason = "memory";
  }

  let line: LocalSetupLine;
  if (reason === "memory") {
    line = { key: "notEnoughMemory", model: model.name, neededGb, haveGb: profile.memoryGb };
  } else if (label === "unavailable") {
    const [low, high] = range;
    if (id === "cleanup") {
      line = { key: "tooSlowCleanupSeconds", model: model.name, seconds: low };
    } else if (high === null || high >= 120) {
      line = { key: "tooSlowMinutes", model: model.name, minutes: Math.floor(low / 60) };
    } else if (high >= 45) {
      line = { key: "tooSlowAboutMinute", model: model.name };
    } else {
      line = { key: "tooSlowAssistantSeconds", model: model.name, range: [low, high] };
    }
  } else if (id === "cleanup") {
    line =
      range[1] < 1
        ? { key: "cleanupUnderSecond" }
        : { key: "cleanupAddsSeconds", range: range as [number, number] };
  } else {
    line = { key: "assistantSeconds", range: range as [number, number] };
  }

  return {
    id,
    modelId,
    modelName: model.name,
    providerIcon: providerId,
    download: { kind: "llm", id: modelId, bytes: model.sizeBytes },
    label,
    ...(reason ? { reason } : {}),
    line,
  };
}

export function buildLocalSetupPlan(input: {
  profile: ComputerProfile;
  spokenLanguages: string[]; // settings.spokenLanguages; [] for guests
  policy: PolicyDecisionSnapshot;
  requiredSpeechModelId?: string; // first org-required speech model, if any
}): LocalSetupPlan {
  const { profile, policy, requiredSpeechModelId } = input;
  const machineType = classifyMachine(profile);
  const machine = table.machines[machineType];
  const spoken = normalizeLanguages(input.spokenLanguages ?? []);
  const languages = spoken.length ? spoken : normalizeLanguages([profile.systemLanguage]);

  const rows: LocalSetupRow[] = [];
  if (isModeAllowedByPolicy(policy, "transcription", "local")) {
    rows.push(dictationRow(profile, machine, languages, requiredSpeechModelId));
  }
  if (isModeAllowedByPolicy(policy, "llm", "local")) {
    rows.push(textRow("cleanup", profile, machine));
    if (isAgentAllowed(policy)) rows.push(textRow("assistant", profile, machine));
  }

  const packBytes = table.graphicsPackBytes[`${profile.platform}-${profile.arch}`];
  const graphicsPack: LocalSetupDownload | null =
    machineType === "pc-nvidia" && packBytes
      ? { kind: "llamaVulkan", id: "llama-vulkan", bytes: packBytes }
      : null;

  return { machineType, profile, languages, rows, graphicsPack };
}

/**
 * What to download, row by row, for the switches the user left on. The
 * graphics pack rides with the first text row that is switched on (call 4).
 */
export function enabledDownloads(
  plan: LocalSetupPlan,
  switches: LocalSetupSwitches
): Array<{ rowId: LocalSetupRowId; items: LocalSetupDownload[] }> {
  const out: Array<{ rowId: LocalSetupRowId; items: LocalSetupDownload[] }> = [];
  let pack = plan.graphicsPack;
  for (const row of plan.rows) {
    if (row.label === "unavailable") continue;
    if (row.id !== "dictation" && !switches[row.id]) continue;
    const items = [row.download];
    if (row.id !== "dictation" && pack) {
      items.push(pack);
      pack = null;
    }
    out.push({ rowId: row.id, items });
  }
  return out;
}

export type SpaceState = "fits" | "trimmed" | "overflow" | "noSpace";
/** The room each download kind reserves while it downloads and unpacks (main's disk checks). */
export type LocalSetupFactors = Record<LocalSetupDownload["kind"], number>;

/** Free disk space the downloads need, counting the room each one reserves. */
export function localSetupRequiredBytes(
  items: LocalSetupDownload[],
  factors: LocalSetupFactors
): number {
  return items.reduce((sum, item) => sum + item.bytes * (factors[item.kind] ?? 1), 0);
}

// Turned off in this order until the downloads fit (design §4.5).
const TRIM_ORDER: Array<keyof LocalSetupSwitches> = ["assistant", "cleanup"];

/**
 * Fits the switched-on rows to the free space. A switch the user set in
 * `requested` is kept as set; one left out starts on and may be turned off to fit,
 * the assistant first, then cleanup. When the user's own switches don't fit, the
 * state is "overflow" and the download stays locked instead of re-trimming them.
 * `requiredBytes` is what the resulting switches need, or dictation alone for
 * "noSpace". Items `isOnDisk` reports cost nothing, and a row whose items are all
 * on disk is never turned off to fit: there is nothing left to download for it.
 */
export function fitLocalSetupToSpace(
  plan: LocalSetupPlan,
  requested: Partial<LocalSetupSwitches>,
  space: { availableBytes: number; factors: LocalSetupFactors },
  isOnDisk: (item: LocalSetupDownload) => boolean = () => false
): {
  switches: LocalSetupSwitches;
  autoOff: LocalSetupRowId[];
  state: SpaceState;
  requiredBytes: number;
} {
  const need = (switches: LocalSetupSwitches) =>
    localSetupRequiredBytes(
      enabledDownloads(plan, switches)
        .flatMap((row) => row.items)
        .filter((item) => !isOnDisk(item)),
      space.factors
    );
  const fits = (bytes: number) => bytes <= space.availableBytes;

  const switches: LocalSetupSwitches = {
    cleanup: requested.cleanup ?? true,
    assistant: requested.assistant ?? true,
  };
  const autoOff: LocalSetupRowId[] = [];
  const trimmable = (id: keyof LocalSetupSwitches) => {
    const row = plan.rows.find((r) => r.id === id);
    if (requested[id] !== undefined || !switches[id] || !row || row.label === "unavailable") {
      return false;
    }
    // Already downloaded, pack included: turning it off frees nothing.
    const items = enabledDownloads(plan, switches).find((r) => r.rowId === id)?.items ?? [];
    return !items.every(isOnDisk);
  };

  const dictationOnly = need({ cleanup: false, assistant: false });
  if (!fits(dictationOnly)) {
    for (const id of TRIM_ORDER) {
      if (!trimmable(id)) continue;
      switches[id] = false;
      autoOff.push(id);
    }
    return { switches, autoOff, state: "noSpace", requiredBytes: dictationOnly };
  }

  for (const id of TRIM_ORDER) {
    if (fits(need(switches))) break;
    if (!trimmable(id)) continue;
    switches[id] = false;
    autoOff.push(id);
  }
  const requiredBytes = need(switches);
  const state: SpaceState = !fits(requiredBytes) ? "overflow" : autoOff.length ? "trimmed" : "fits";
  return { switches, autoOff, state, requiredBytes };
}

function registrySize(download: LocalSetupDownload): string {
  if (download.kind === "llm") return textModels.get(download.id)?.model.size ?? "";
  const info =
    download.kind === "parakeet" ? parakeetModels[download.id] : whisperModels[download.id];
  return info?.size ?? "";
}

/** The size Settings shows for the row's model, or the combined size with the pack folded in. */
export function rowSizeLabel(row: LocalSetupRow, pack: LocalSetupDownload | null): string {
  if (pack) return formatBytes(row.download.bytes + pack.bytes, 1);
  return spaceSizeUnit(registrySize(row.download));
}
