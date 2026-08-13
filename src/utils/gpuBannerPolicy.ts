import type { InferenceMode } from "../types/electron";

export interface GpuOfferInputs {
  useLocalWhisper: boolean;
  localTranscriptionProvider: string;
  useCleanupModel: boolean;
  cleanupMode: InferenceMode;
}

export interface GpuOffers {
  transcription: boolean;
  intelligence: boolean;
}

// The Home-screen GPU banner offers to install local acceleration binaries, so
// each branch must require its engine to actually run locally — with cloud
// cleanup there is nothing a local Vulkan build could accelerate, and the
// Enable GPU button would land on a pane without the install control (#1509).
export function eligibleGpuOffers(inputs: GpuOfferInputs): GpuOffers {
  return {
    transcription: inputs.useLocalWhisper && inputs.localTranscriptionProvider === "whisper",
    intelligence: inputs.useCleanupModel && inputs.cleanupMode === "local",
  };
}
