import { useSettingsStore } from "../../stores/settingsStore";
import type {
  ManagedEnterpriseLocalModelSelection,
  ManagedEnterpriseLocalModels,
} from "../../types/enterpriseIdentity";
import type { ManagedLocalModelCategory } from "./managedLocalModels";

export const MANAGED_LOCAL_MODEL_PREFERENCES_KEY = "openwhispr:managed-local-model-preferences:v2";

const SNAPSHOT_VERSION = 2;
const INFERENCE_MODES = new Set(["openwhispr", "providers", "local", "self-hosted", "enterprise"]);
const TRANSCRIPTION_MODES = new Set(["openwhispr", "providers", "local", "self-hosted"]);
const TRANSCRIPTION_MODE_KEYS = new Set([
  "transcriptionMode",
  "meetingTranscriptionMode",
  "uploadTranscriptionMode",
]);
const REASONING_MODE_KEYS = new Set([
  "cleanupMode",
  "noteFormattingMode",
  "dictationAgentMode",
  "chatAgentMode",
  "translationMode",
]);
const TRANSCRIPTION_BOOLEAN_KEYS = new Set([
  "useLocalWhisper",
  "meetingUseLocalWhisper",
  "uploadUseLocalWhisper",
]);
const LOCAL_TRANSCRIPTION_PROVIDER_KEYS = new Set([
  "localTranscriptionProvider",
  "meetingLocalTranscriptionProvider",
  "uploadLocalTranscriptionProvider",
]);
const MODEL_MEMORY_KEYS = new Set(["transcriptionModelByProvider"]);
const EMPTY_KEYS = new Set<string>();

const TRANSCRIPTION_SETTING_KEYS = [
  "transcriptionMode",
  "useLocalWhisper",
  "localTranscriptionProvider",
  "whisperModel",
  "parakeetModel",
  "meetingTranscriptionMode",
  "meetingUseLocalWhisper",
  "meetingLocalTranscriptionProvider",
  "meetingWhisperModel",
  "meetingParakeetModel",
  "meetingCloudTranscriptionMode",
  "meetingCloudTranscriptionProvider",
  "meetingCloudTranscriptionModel",
  "uploadTranscriptionMode",
  "uploadUseLocalWhisper",
  "uploadLocalTranscriptionProvider",
  "uploadWhisperModel",
  "uploadParakeetModel",
  "uploadCloudTranscriptionMode",
  "uploadCloudTranscriptionProvider",
  "uploadCloudTranscriptionModel",
  "transcriptionModelByProvider",
] as const;

const REASONING_SETTING_KEYS = [
  "cleanupMode",
  "cleanupProvider",
  "cleanupModel",
  "noteFormattingMode",
  "noteFormattingProvider",
  "noteFormattingModel",
  "dictationAgentMode",
  "dictationAgentProvider",
  "dictationAgentModel",
  "chatAgentMode",
  "chatAgentProvider",
  "chatAgentModel",
  "translationMode",
  "translationProvider",
  "translationModel",
] as const;

type TranscriptionSettingKey = (typeof TRANSCRIPTION_SETTING_KEYS)[number];
type ReasoningSettingKey = (typeof REASONING_SETTING_KEYS)[number];
type RouteSettingValue = string | boolean | Record<string, string>;
interface PersistedSettingSnapshot<SettingValue extends RouteSettingValue = RouteSettingValue> {
  value: SettingValue;
  persisted: boolean;
}
type RouteSettingsSnapshot<SettingKey extends string> = Record<
  SettingKey,
  PersistedSettingSnapshot
>;

interface ManagedLocalModelPreferenceSnapshot {
  version: typeof SNAPSHOT_VERSION;
  transcription?: RouteSettingsSnapshot<TranscriptionSettingKey>;
  reasoning?: RouteSettingsSnapshot<ReasoningSettingKey>;
  forcedUseDictationAgent?: PersistedSettingSnapshot<boolean>;
}

type SnapshotReadResult =
  | { status: "missing" }
  | { status: "invalid" }
  | { status: "valid"; snapshot: ManagedLocalModelPreferenceSnapshot };

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

function isRouteSettingsSnapshot(
  value: unknown,
  keys: readonly string[],
  booleanKeys: ReadonlySet<string>,
  recordKeys: ReadonlySet<string>,
  modeKeys: ReadonlySet<string> = EMPTY_KEYS
): value is RouteSettingsSnapshot<string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== keys.length) return false;
  return keys.every((key) => {
    const rawEntry = record[key];
    if (typeof rawEntry !== "object" || rawEntry === null || Array.isArray(rawEntry)) return false;
    const entry = rawEntry as Record<string, unknown>;
    if (
      Object.keys(entry).length !== 2 ||
      typeof entry.persisted !== "boolean" ||
      !("value" in entry)
    ) {
      return false;
    }
    if (booleanKeys.has(key)) return typeof entry.value === "boolean";
    if (recordKeys.has(key)) return isStringRecord(entry.value);
    if (modeKeys.has(key)) {
      return (
        typeof entry.value === "string" &&
        (TRANSCRIPTION_MODE_KEYS.has(key)
          ? TRANSCRIPTION_MODES.has(entry.value)
          : INFERENCE_MODES.has(entry.value))
      );
    }
    if (LOCAL_TRANSCRIPTION_PROVIDER_KEYS.has(key)) {
      return entry.value === "whisper" || entry.value === "nvidia";
    }
    return typeof entry.value === "string";
  });
}

function isBooleanSettingSnapshot(value: unknown): value is PersistedSettingSnapshot<boolean> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return (
    Object.keys(entry).length === 2 &&
    typeof entry.value === "boolean" &&
    typeof entry.persisted === "boolean"
  );
}

function readPreferenceSnapshot(): SnapshotReadResult {
  const raw = localStorage.getItem(MANAGED_LOCAL_MODEL_PREFERENCES_KEY);
  if (raw === null) return { status: "missing" };
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      parsed.version !== SNAPSHOT_VERSION ||
      Object.keys(parsed).some(
        (key) =>
          key !== "version" &&
          key !== "transcription" &&
          key !== "reasoning" &&
          key !== "forcedUseDictationAgent"
      ) ||
      (parsed.transcription === undefined && parsed.reasoning === undefined) ||
      (parsed.transcription !== undefined &&
        !isRouteSettingsSnapshot(
          parsed.transcription,
          TRANSCRIPTION_SETTING_KEYS,
          TRANSCRIPTION_BOOLEAN_KEYS,
          MODEL_MEMORY_KEYS,
          TRANSCRIPTION_MODE_KEYS
        )) ||
      (parsed.reasoning !== undefined &&
        !isRouteSettingsSnapshot(
          parsed.reasoning,
          REASONING_SETTING_KEYS,
          EMPTY_KEYS,
          EMPTY_KEYS,
          REASONING_MODE_KEYS
        )) ||
      (parsed.forcedUseDictationAgent !== undefined &&
        (!isBooleanSettingSnapshot(parsed.forcedUseDictationAgent) ||
          parsed.reasoning === undefined))
    ) {
      return { status: "invalid" };
    }
    return { status: "valid", snapshot: parsed as unknown as ManagedLocalModelPreferenceSnapshot };
  } catch {
    return { status: "invalid" };
  }
}

function writePreferenceSnapshot(snapshot: ManagedLocalModelPreferenceSnapshot): void {
  localStorage.setItem(MANAGED_LOCAL_MODEL_PREFERENCES_KEY, JSON.stringify(snapshot));
}

function captureSettings<SettingKey extends keyof ReturnType<typeof useSettingsStore.getState>>(
  keys: readonly SettingKey[]
): RouteSettingsSnapshot<Extract<SettingKey, string>> {
  const settings = useSettingsStore.getState();
  return Object.fromEntries(
    keys.map((key) => [
      key,
      {
        value: settings[key],
        persisted: localStorage.getItem(String(key)) !== null,
      },
    ])
  ) as unknown as RouteSettingsSnapshot<Extract<SettingKey, string>>;
}

function captureManagedPreferenceBaseline(
  category: ManagedLocalModelCategory,
  willForceDictationAgentOff: boolean
): void {
  const read = readPreferenceSnapshot();
  if (read.status === "invalid") return;
  const snapshot: ManagedLocalModelPreferenceSnapshot =
    read.status === "valid" ? read.snapshot : { version: SNAPSHOT_VERSION };
  let changed = false;
  if (!snapshot[category]) {
    if (category === "transcription") {
      snapshot.transcription = captureSettings(TRANSCRIPTION_SETTING_KEYS);
    } else {
      snapshot.reasoning = captureSettings(REASONING_SETTING_KEYS);
    }
    changed = true;
  }
  if (
    category === "reasoning" &&
    willForceDictationAgentOff &&
    snapshot.forcedUseDictationAgent === undefined
  ) {
    snapshot.forcedUseDictationAgent = {
      value: useSettingsStore.getState().useDictationAgent,
      persisted: localStorage.getItem("useDictationAgent") !== null,
    };
    changed = true;
  }
  if (changed) writePreferenceSnapshot(snapshot);
}

function persistRestoredSetting(key: string, setting: PersistedSettingSnapshot): RouteSettingValue {
  const serialized =
    typeof setting.value === "object" ? JSON.stringify(setting.value) : String(setting.value);
  // The value write synchronizes the hydrated fallback to other renderers. A
  // following removal restores inheritance without leaving their stores stale.
  localStorage.setItem(key, serialized);
  if (!setting.persisted) localStorage.removeItem(key);
  return setting.value;
}

function persistRestoredSettings(settings: Record<string, PersistedSettingSnapshot>): void {
  const restored = Object.fromEntries(
    Object.entries(settings).map(([key, setting]) => [key, persistRestoredSetting(key, setting)])
  );
  useSettingsStore.setState(restored);
}

function restoreForcedDictationAgent(setting: PersistedSettingSnapshot<boolean>): void {
  const useDictationAgent = persistRestoredSetting("useDictationAgent", setting);
  if (typeof useDictationAgent === "boolean") {
    useSettingsStore.setState({ useDictationAgent });
  }
}

export function restoreManagedLocalModelSettings(
  categories: readonly ManagedLocalModelCategory[] = ["transcription", "reasoning"]
): void {
  const read = readPreferenceSnapshot();
  if (read.status === "missing") return;
  if (read.status === "invalid") {
    localStorage.removeItem(MANAGED_LOCAL_MODEL_PREFERENCES_KEY);
    return;
  }
  const snapshot = read.snapshot;
  for (const category of categories) {
    const settings = snapshot[category];
    if (!settings) continue;
    persistRestoredSettings(settings);
    delete snapshot[category];
    if (category === "reasoning" && snapshot.forcedUseDictationAgent !== undefined) {
      restoreForcedDictationAgent(snapshot.forcedUseDictationAgent);
      delete snapshot.forcedUseDictationAgent;
    }
  }
  if (!snapshot.transcription && !snapshot.reasoning) {
    localStorage.removeItem(MANAGED_LOCAL_MODEL_PREFERENCES_KEY);
  } else {
    writePreferenceSnapshot(snapshot);
  }
}

export function reconcileManagedLocalModelSettings({
  ownsReconciliation,
  status,
  failClosed,
  localModels,
}: {
  ownsReconciliation: boolean;
  status: "idle" | "loading" | "ready" | "error";
  failClosed: boolean;
  localModels: ManagedEnterpriseLocalModels | null;
}): void {
  const definitiveUnmanaged = status === "error" && !failClosed;
  if (!ownsReconciliation || (status !== "ready" && !definitiveUnmanaged)) return;
  const unmanagedCategories: ManagedLocalModelCategory[] = [];
  if (!localModels?.transcription.length) unmanagedCategories.push("transcription");
  if (!localModels?.reasoning.length) unmanagedCategories.push("reasoning");
  restoreManagedLocalModelSettings(unmanagedCategories);
}

export function isManagedLocalModelSettingsEnforced(
  category: ManagedLocalModelCategory,
  selection: ManagedEnterpriseLocalModelSelection,
  agentAllowed = true
): boolean {
  const settings = useSettingsStore.getState();
  if (category === "transcription") {
    const provider = selection.provider === "nvidia" ? "nvidia" : "whisper";
    const matchesModel = (whisperModel: string, parakeetModel: string): boolean =>
      provider === "nvidia"
        ? parakeetModel === selection.modelId
        : whisperModel === selection.modelId;
    return (
      settings.transcriptionMode === "local" &&
      settings.useLocalWhisper &&
      settings.localTranscriptionProvider === provider &&
      matchesModel(settings.whisperModel, settings.parakeetModel) &&
      settings.meetingTranscriptionMode === "local" &&
      settings.meetingUseLocalWhisper &&
      settings.meetingLocalTranscriptionProvider === provider &&
      matchesModel(settings.meetingWhisperModel, settings.meetingParakeetModel) &&
      settings.uploadTranscriptionMode === "local" &&
      settings.uploadUseLocalWhisper &&
      settings.uploadLocalTranscriptionProvider === provider &&
      matchesModel(settings.uploadWhisperModel, settings.uploadParakeetModel)
    );
  }

  return (
    settings.cleanupMode === "local" &&
    settings.cleanupProvider === selection.provider &&
    settings.cleanupModel === selection.modelId &&
    settings.noteFormattingMode === "local" &&
    settings.noteFormattingProvider === selection.provider &&
    settings.noteFormattingModel === selection.modelId &&
    settings.dictationAgentMode === "local" &&
    settings.dictationAgentProvider === selection.provider &&
    settings.dictationAgentModel === selection.modelId &&
    settings.chatAgentMode === "local" &&
    settings.chatAgentProvider === selection.provider &&
    settings.chatAgentModel === selection.modelId &&
    settings.translationMode === "local" &&
    settings.translationProvider === selection.provider &&
    settings.translationModel === selection.modelId &&
    (agentAllowed || !settings.useDictationAgent)
  );
}

export function enforceManagedLocalModelSettings(
  category: ManagedLocalModelCategory,
  selection: ManagedEnterpriseLocalModelSelection,
  agentAllowed = true
): void {
  if (isManagedLocalModelSettingsEnforced(category, selection, agentAllowed)) return;
  const settings = useSettingsStore.getState();
  captureManagedPreferenceBaseline(category, !agentAllowed && settings.useDictationAgent);
  if (category === "transcription") {
    const provider = selection.provider === "nvidia" ? "nvidia" : "whisper";
    settings.setCloudTranscriptionForAllScopes({
      useLocalWhisper: true,
      localTranscriptionProvider: provider,
      ...(provider === "nvidia"
        ? { parakeetModel: selection.modelId }
        : { whisperModel: selection.modelId }),
    });
    return;
  }
  settings.setCloudReasoningForAllScopes({
    cleanupCloudMode: "local",
    cleanupProvider: selection.provider,
    cleanupModel: selection.modelId,
    ...(!agentAllowed && settings.useDictationAgent ? { useDictationAgent: false } : {}),
  });
}
