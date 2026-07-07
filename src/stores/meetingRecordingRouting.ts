import type { InferenceMode, LocalTranscriptionProvider } from "../types/electron";

export type MeetingTranscriptionUnavailableReason =
  | "account_required"
  | "byok_key_required"
  | "provider_unavailable"
  | "self_hosted_streaming_unavailable";

export interface MeetingStreamingProviderModel {
  id: string;
  default?: boolean;
}

export interface MeetingStreamingProvider {
  id: string;
  models: MeetingStreamingProviderModel[];
}

export interface MeetingTranscriptionRoutingInput {
  isSignedIn: boolean;
  mode: InferenceMode;
  useLocalWhisper: boolean;
  localTranscriptionProvider?: LocalTranscriptionProvider;
  parakeetModel?: string;
  whisperModel?: string;
  cloudTranscriptionMode?: string;
  selectedProviderId?: string;
  cloudTranscriptionModel?: string;
  language?: string;
  streamingProvider?: MeetingStreamingProvider | null;
  openaiApiKey?: string;
  cortiClientId?: string;
  cortiClientSecret?: string;
  cortiEnvironment?: string;
  cortiTenant?: string;
  keyterms?: string[];
}

export type MeetingTranscriptionRoute =
  | {
      usable: true;
      options: Record<string, unknown>;
    }
  | {
      usable: false;
      reason: MeetingTranscriptionUnavailableReason;
      alternatives: Array<"local" | "providers">;
    };

export function resolveMeetingTranscriptionRoute(
  input: MeetingTranscriptionRoutingInput
): MeetingTranscriptionRoute {
  if (input.useLocalWhisper || input.mode === "local") {
    const localProvider = input.localTranscriptionProvider || "whisper";
    return {
      usable: true,
      options: {
        provider: "local",
        localProvider,
        localModel:
          localProvider === "nvidia"
            ? input.parakeetModel || "parakeet-tdt-0.6b-v3"
            : input.whisperModel || "base",
        language: input.language,
      },
    };
  }

  if (input.mode === "self-hosted") {
    return unavailable("self_hosted_streaming_unavailable");
  }

  const selectedProviderId = input.selectedProviderId || input.streamingProvider?.id || "openai";
  const cloudMode = input.cloudTranscriptionMode || (input.mode === "openwhispr" ? "openwhispr" : "byok");

  if (cloudMode === "openwhispr" || input.mode === "openwhispr") {
    if (!input.isSignedIn) return unavailable("account_required");
    return {
      usable: true,
      options: resolveRealtimeOptions(input, selectedProviderId, "openwhispr"),
    };
  }

  if (selectedProviderId === "corti") {
    if (!input.cortiClientId || !input.cortiClientSecret) return unavailable("byok_key_required");
    return {
      usable: true,
      options: {
        provider: "corti-realtime",
        model: "corti-transcribe",
        mode: "byok",
        language: input.language,
        environment: input.cortiEnvironment,
        tenant: input.cortiTenant,
        keyterms: input.keyterms ?? [],
      },
    };
  }

  if (selectedProviderId === "openai" && !input.openaiApiKey) {
    return unavailable("byok_key_required");
  }

  return {
    usable: true,
    options: resolveRealtimeOptions(input, selectedProviderId, "byok"),
  };
}

export function getMeetingDiarizationAvailability(input: {
  enabled: boolean;
  isSubscribed?: boolean;
  isTrial?: boolean;
}): { available: boolean; reason: "local_available" | "disabled" } {
  return input.enabled
    ? { available: true, reason: "local_available" }
    : { available: false, reason: "disabled" };
}

export function getMeetingRoutingErrorMessage(reason: MeetingTranscriptionUnavailableReason): string {
  switch (reason) {
    case "account_required":
      return "OpenWhispr Cloud meeting transcription requires a signed-in account. Switch to Local or Providers.";
    case "byok_key_required":
      return "Meeting transcription needs provider credentials. Add your key or switch to Local.";
    case "self_hosted_streaming_unavailable":
      return "Self-hosted meeting transcription needs a streaming-compatible endpoint. Switch to Local or Providers.";
    default:
      return "Meeting transcription provider is unavailable. Switch to Local or Providers.";
  }
}

function resolveRealtimeOptions(
  input: MeetingTranscriptionRoutingInput,
  providerId: string,
  mode: "byok" | "openwhispr"
): Record<string, unknown> {
  const provider = input.streamingProvider;
  const configuredModel =
    provider?.models.find((m) => m.id === input.cloudTranscriptionModel)?.id ??
    provider?.models.find((m) => m.default)?.id ??
    provider?.models[0]?.id ??
    input.cloudTranscriptionModel;
  const model = configuredModel || "gpt-4o-mini-transcribe";

  return {
    provider: `${provider?.id || providerId}-realtime`,
    model,
    mode,
    language: input.language,
  };
}

function unavailable(reason: MeetingTranscriptionUnavailableReason): MeetingTranscriptionRoute {
  return {
    usable: false,
    reason,
    alternatives: ["local", "providers"],
  };
}
