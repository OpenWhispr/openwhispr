import type { InferenceMode, LocalTranscriptionProvider } from "../types/electron";

export interface GpuOfferInputs {
  useLocalWhisper: boolean;
  localTranscriptionProvider: LocalTranscriptionProvider;
  useCleanupModel: boolean;
  cleanupMode: InferenceMode;
  useDictationAgent: boolean;
  dictationAgentMode: InferenceMode;
  agentAllowedByPolicy: boolean;
}

export type IntelligenceGpuTarget = "cleanup" | "dictationAgent";

export interface GpuOffers {
  transcription: boolean;
  intelligence: IntelligenceGpuTarget | null;
}

// The Home-screen GPU banner offers to install local acceleration binaries, so
// each branch must require an engine that actually runs locally — otherwise the
// Enable GPU button would land on a settings pane without the install control
// (#1509). Cleanup and the dictation agent share the local llama server (see
// resolveLocalServerNeeds), so either one running locally makes the Vulkan
// pack worth offering; the target names the settings tab that carries the
// install control. A policy-blocked agent gets no offer — its tab is hidden.
//
// Modes must be policy-effective (selectPolicyEffectiveSettings), not raw: the
// settings pane renders the clamped mode, so a managed profile that forbids
// local inference leaves the raw mode at "local" pointing at a pane that shows
// no install control — the same dead end #1509 reported.
export function eligibleGpuOffers(inputs: GpuOfferInputs): GpuOffers {
  const cleanupLocal = inputs.useCleanupModel && inputs.cleanupMode === "local";
  const agentLocal =
    inputs.useDictationAgent &&
    inputs.agentAllowedByPolicy &&
    inputs.dictationAgentMode === "local";
  return {
    transcription: inputs.useLocalWhisper && inputs.localTranscriptionProvider === "whisper",
    intelligence: cleanupLocal ? "cleanup" : agentLocal ? "dictationAgent" : null,
  };
}
