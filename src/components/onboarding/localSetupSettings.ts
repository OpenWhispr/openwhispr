// Writes onboarding's "We recommend these settings" choice into Settings on
// Proceed. A row that is switched off, unavailable on this computer or hidden by
// policy is written off on this device with no model, never left on the Cloud
// default: a signed-in profile's untouched scopes otherwise answer on OpenWhispr
// Cloud (note formatting and chat have no on/off switch of their own).
import type { InferenceScope } from "../../config/inferenceScopes";
import type { LocalSetupPlan, LocalSetupRow, LocalSetupSwitches } from "../../config/localSetup";
import { modelRegistry } from "../../models/ModelRegistry";
import { setResolvedLLMConfig, useSettingsStore } from "../../stores/settingsStore";
import { discardPendingLocalSetup } from "./pendingLocalModels";

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
