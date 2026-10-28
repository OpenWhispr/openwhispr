// Writes onboarding's "We recommend these settings" choice into Settings on
// Proceed. A row that is switched off, unavailable on this computer or hidden by
// policy is written off on this device with no model, never left on the Cloud
// default: a signed-in profile's untouched scopes otherwise answer on OpenWhispr
// Cloud (note formatting and chat have no on/off switch of their own). A row
// still downloading at Proceed is written off the same way and switched on when
// its model lands, unless Settings changed it meanwhile.
import type { InferenceScope } from "../../config/inferenceScopes";
import type {
  LocalSetupPlan,
  LocalSetupRow,
  LocalSetupRowId,
  LocalSetupSwitches,
} from "../../config/localSetup";
import { modelRegistry } from "../../models/ModelRegistry";
import {
  selectResolvedLLMConfig,
  setResolvedLLMConfig,
  useSettingsStore,
} from "../../stores/settingsStore";
import {
  consumePendingLocalModel,
  discardPendingLocalSetup,
  rememberPendingLocalModel,
} from "./pendingLocalModels";

const CLEANUP_SCOPES: InferenceScope[] = [
  "dictationCleanup",
  "noteFormatting",
  "dictationTranslation",
];
// dictationAgentVision stays untouched: it is inactive until the user picks its
// own model, and inherits dictationAgent meanwhile.
const ASSISTANT_SCOPES: InferenceScope[] = ["dictationAgent", "chatIntelligence"];

function isOn(row: LocalSetupRow | undefined, switchedOn: boolean): row is LocalSetupRow {
  return !!row && row.label !== "unavailable" && switchedOn;
}

// A model the registry doesn't know is written off too, never half-configured.
// The *CloudMode fields are left alone: they only ever hold real cloud routings
// (see setCloudReasoningForAllScopes).
function writeScopes(scopes: InferenceScope[], modelId: string | null): void {
  const provider = modelId ? modelRegistry.getModel(modelId)?.provider.id : undefined;
  const config =
    modelId && provider
      ? { mode: "local" as const, provider, model: modelId }
      : { mode: "local" as const, provider: "", model: "" };
  for (const scope of scopes) {
    setResolvedLLMConfig(scope, config);
  }
}

function writeDictation(row: LocalSetupRow): void {
  const s = useSettingsStore.getState();
  if (row.download.kind === "whisper") {
    s.setLocalTranscriptionProvider("whisper");
    s.setWhisperModel(row.modelId);
  } else if (row.providerIcon === "cohere") {
    // Only reachable as an organisation-required model; Cohere has its own engine slot.
    s.setLocalTranscriptionProvider("cohere");
    s.setCohereModel(row.modelId);
  } else {
    // Oruk and NVIDIA models both run on the nvidia manager.
    s.setLocalTranscriptionProvider("nvidia");
    s.setParakeetModel(row.modelId);
  }
  // Mirrors the local engine to note recording and audio upload.
  s.setCloudTranscriptionForAllScopes({ useLocalWhisper: true });
}

export function applyLocalSetupSettings(plan: LocalSetupPlan, switches: LocalSetupSwitches): void {
  // An older build's pending pick would otherwise be applied later by the tray,
  // over these switches.
  discardPendingLocalSetup();

  const row = (id: LocalSetupRow["id"]) => plan.rows.find((r) => r.id === id);

  const dictation = row("dictation");
  if (dictation) writeDictation(dictation);

  const s = useSettingsStore.getState();
  const cleanup = row("cleanup");
  if (isOn(cleanup, switches.cleanup)) {
    writeScopes(CLEANUP_SCOPES, cleanup.modelId);
    s.setUseCleanupModel(true);
  } else {
    writeScopes(CLEANUP_SCOPES, null);
    s.setUseCleanupModel(false);
    s.setUseDictationTranslation(false);
  }

  const assistant = row("assistant");
  if (isOn(assistant, switches.assistant)) {
    writeScopes(ASSISTANT_SCOPES, assistant.modelId);
    s.setUseDictationAgent(true);
  } else {
    writeScopes(ASSISTANT_SCOPES, null);
    s.setUseDictationAgent(false);
  }
}

type OptionalRowId = Exclude<LocalSetupRowId, "dictation">;

/** Rows switched on at Proceed whose models are still downloading. */
export function rememberPendingLocalSetupRows(plan: LocalSetupPlan, rowIds: OptionalRowId[]): void {
  for (const id of rowIds) {
    const row = plan.rows.find((r) => r.id === id);
    const provider = row && modelRegistry.getModel(row.modelId)?.provider.id;
    if (row && provider) rememberPendingLocalModel(id, { provider, modelId: row.modelId });
  }
}

/**
 * A pending row's model is on disk: its scopes still off with no model (as
 * Proceed left them) get it, and the row's switch turns on if its main scope did.
 * A scope the user has since pointed elsewhere keeps their choice.
 */
export function activatePendingLocalSetupModel(modelId: string): void {
  for (const id of ["cleanup", "assistant"] as const) {
    if (!consumePendingLocalModel(id, modelId)) continue;
    const scopes = id === "cleanup" ? CLEANUP_SCOPES : ASSISTANT_SCOPES;
    const state = useSettingsStore.getState();
    const untouched = scopes.filter((scope) => {
      const config = selectResolvedLLMConfig(state, scope);
      return config.mode === "local" && !config.model;
    });
    writeScopes(untouched, modelId);
    if (!untouched.includes(scopes[0])) continue;
    if (id === "cleanup") state.setUseCleanupModel(true);
    else state.setUseDictationAgent(true);
  }
}
