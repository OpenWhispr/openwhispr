import { withSessionRefresh } from "../lib/auth";
import { resolveTranscriptionRoute } from "../helpers/transcriptionRoute";
import { getTranscriptionProviders } from "../models/ModelRegistry";
import {
  resolveDiarizationTarget,
  resolveEffectiveDiarizationModel,
} from "../helpers/transcriptionDiarizationRoute";
import {
  captureManagedRuntimeAuthorizationContext,
  resolveManagedLocalTranscriptionRuntime,
} from "../helpers/managedLocalTranscriptionRuntime";
import type { ManagedRuntimeAuthorizationContext } from "../types/electron";

export interface FileTranscriptionResult {
  success: boolean;
  text?: string;
  error?: string;
  code?: string;
  diarized?: boolean;
  warning?: string;
  // Set alongside `warning` by the chunked cloud path: how much audio was lost.
  failedChunks?: number;
  totalChunks?: number;
  // Measured duration of the source audio, for persisting as
  // audio_duration_seconds. Only transcribeFileWithSpeakers sets it.
  durationSeconds?: number | null;
  // Segment-level timing from BYOK providers that support it (opts.timestamps
  // or BYOK diarization). Absent whenever the provider returned text only.
  segments?: Array<{ text: string; start: number; end: number; speaker?: string }>;
}

export interface DiarizationSettings {
  enabled: boolean;
  // Local sherpa-onnx models present; BYOK-native diarization doesn't need them.
  localModelsReady: boolean;
  numSpeakers: number | null;
}

export interface FileTranscriptionConfig {
  useLocalWhisper: boolean;
  localTranscriptionProvider: string;
  whisperModel: string;
  parakeetModel: string;
  isOpenWhisprCloud: boolean;
  getApiKey: () => string;
  cloudTranscriptionProvider: string;
  cloudTranscriptionBaseUrl: string;
  cloudTranscriptionModel: string;
  language: string;
  cortiEnvironment?: string;
  cortiTenant?: string;
  transcriptionMode?: string;
  remoteTranscriptionUrl?: string;
  remoteTranscriptionModel?: string;
}

export interface TranscriptionApiKeys {
  openaiApiKey: string;
  groqApiKey: string;
  xaiApiKey: string;
  mistralApiKey: string;
  tinfoilApiKey: string;
  customTranscriptionApiKey?: string;
}

interface FileTranscriptionOptions {
  requestId?: string;
  timestamps?: boolean;
}

type FileTranscriptionPlan =
  | { kind: "error"; result: FileTranscriptionResult }
  | {
      kind: "local";
      provider: "whisper" | "nvidia";
      model: string;
      authorizationContext: ManagedRuntimeAuthorizationContext;
    }
  | { kind: "cloud"; authorizationContext: ManagedRuntimeAuthorizationContext }
  | { kind: "byok"; authorizationContext: ManagedRuntimeAuthorizationContext };

export function getTranscriptionApiKey(provider: string, keys: TranscriptionApiKeys): string {
  switch (provider) {
    case "openai":
      return keys.openaiApiKey;
    case "groq":
      return keys.groqApiKey;
    case "xai":
      return keys.xaiApiKey;
    case "mistral":
      return keys.mistralApiKey;
    case "tinfoil":
      return keys.tinfoilApiKey;
    case "custom":
      return keys.customTranscriptionApiKey || "";
    default:
      return "";
  }
}

function resolveFileTranscriptionPlan(
  cfg: FileTranscriptionConfig,
  diarize = false
): FileTranscriptionPlan {
  const runtime = resolveManagedLocalTranscriptionRuntime(cfg);
  if (runtime.kind === "error") {
    return {
      kind: "error",
      result: { success: false, error: runtime.message, code: runtime.code },
    };
  }
  if (runtime.managed) {
    const settings = runtime.settings;
    const provider = settings.localTranscriptionProvider === "nvidia" ? "nvidia" : "whisper";
    const model = provider === "nvidia" ? settings.parakeetModel : settings.whisperModel;
    return {
      kind: "local",
      provider,
      model,
      authorizationContext: captureManagedRuntimeAuthorizationContext({
        managed: true,
        transcriptionMode: "local",
        provider,
        model,
      }),
    };
  }
  if (cfg.isOpenWhisprCloud) {
    return {
      kind: "cloud",
      authorizationContext: captureManagedRuntimeAuthorizationContext({
        managed: false,
        transcriptionMode: "openwhispr",
        provider: "openwhispr",
        model: null,
      }),
    };
  }

  if (cfg.useLocalWhisper) {
    const provider = cfg.localTranscriptionProvider === "nvidia" ? "nvidia" : "whisper";
    const model = provider === "nvidia" ? cfg.parakeetModel : cfg.whisperModel;
    return {
      kind: "local",
      provider,
      model,
      authorizationContext: captureManagedRuntimeAuthorizationContext({
        managed: false,
        transcriptionMode: "local",
        provider,
        model,
      }),
    };
  }

  // Pre-flight through the shared resolver: code-carrying errors (incl. the
  // Tinfoil-URL and fail-closed custom guards) surface here without an IPC
  // round-trip; the main-process handler re-resolves the same fields as
  // defense in depth.
  const route = resolveTranscriptionRoute({
    settings: {
      transcriptionMode: cfg.transcriptionMode,
      remoteTranscriptionUrl: cfg.remoteTranscriptionUrl,
      remoteTranscriptionModel: cfg.remoteTranscriptionModel,
      cloudTranscriptionProvider: cfg.cloudTranscriptionProvider,
      cloudTranscriptionModel: cfg.cloudTranscriptionModel,
      cloudTranscriptionBaseUrl: cfg.cloudTranscriptionBaseUrl,
      cortiEnvironment: cfg.cortiEnvironment,
      cortiTenant: cfg.cortiTenant,
    },
    providers: getTranscriptionProviders(),
    request: { effectiveLanguage: cfg.language || undefined },
  });
  if (route.transport === "error") {
    return {
      kind: "error",
      result: { success: false, error: route.message, code: route.code },
    };
  }
  const runtimeRoute =
    route.transport === "local"
      ? {
          provider: cfg.localTranscriptionProvider,
          model: cfg.localTranscriptionProvider === "nvidia" ? cfg.parakeetModel : cfg.whisperModel,
        }
      : route;

  return {
    kind: "byok",
    authorizationContext: captureManagedRuntimeAuthorizationContext({
      managed: false,
      transcriptionMode: runtimeRoute.provider === "self-hosted" ? "self-hosted" : "providers",
      provider: runtimeRoute.provider,
      model: resolveEffectiveDiarizationModel(runtimeRoute, diarize),
    }),
  };
}

async function transcribeFileUsingPlan(
  filePath: string,
  cfg: FileTranscriptionConfig,
  diarize: boolean,
  opts: FileTranscriptionOptions,
  plan: Exclude<FileTranscriptionPlan, { kind: "error" }>
): Promise<FileTranscriptionResult> {
  if (plan.kind === "local") {
    return window.electronAPI.transcribeAudioFile(
      filePath,
      {
        provider: plan.provider,
        model: plan.model,
        requestId: opts.requestId,
      },
      plan.authorizationContext
    );
  }
  if (plan.kind === "cloud") {
    return withSessionRefresh(async () => {
      const result = await window.electronAPI.transcribeAudioFileCloud!(
        filePath,
        opts,
        plan.authorizationContext
      );
      if (!result.success && result.code) {
        throw Object.assign(new Error(result.error || "Cloud transcription failed"), {
          code: result.code,
        });
      }
      return result;
    });
  }

  // Self-hosted fields make the handler route to the configured server
  // (fail-closed on misconfiguration) instead of stale BYOK settings.
  return window.electronAPI.transcribeAudioFileByok!(
    {
      filePath,
      requestId: opts.requestId,
      apiKey: cfg.getApiKey(),
      baseUrl: cfg.cloudTranscriptionBaseUrl,
      model: cfg.cloudTranscriptionModel,
      diarize: diarize || undefined,
      timestamps: opts.timestamps || undefined,
      provider: cfg.cloudTranscriptionProvider,
      language: cfg.language,
      environment: cfg.cortiEnvironment,
      tenant: cfg.cortiTenant,
      transcriptionMode: cfg.transcriptionMode,
      remoteTranscriptionUrl: cfg.remoteTranscriptionUrl,
      remoteTranscriptionModel: cfg.remoteTranscriptionModel,
    },
    plan.authorizationContext
  );
}

// Single provider dispatch shared by the single-file flow and the batch queue,
// so BYOK providers receive identical options in both.
export async function transcribeFile(
  filePath: string,
  cfg: FileTranscriptionConfig,
  diarize: boolean,
  opts: FileTranscriptionOptions = {}
): Promise<FileTranscriptionResult> {
  const plan = resolveFileTranscriptionPlan(cfg, diarize);
  if (plan.kind === "error") return plan.result;
  return transcribeFileUsingPlan(filePath, cfg, diarize, opts, plan);
}

// OpenAI/Mistral BYOK handle diarization inside the transcription call itself.
// Self-hosted mode routes to the user's own server, which doesn't — those users
// get local diarization like everyone else.
export function shouldUseByokDiarize(
  cfg: FileTranscriptionConfig,
  diarizationEnabled: boolean
): boolean {
  return (
    diarizationEnabled &&
    !cfg.useLocalWhisper &&
    !cfg.isOpenWhisprCloud &&
    cfg.transcriptionMode !== "self-hosted" &&
    resolveDiarizationTarget({
      provider: cfg.cloudTranscriptionProvider,
      endpoint: cfg.cloudTranscriptionBaseUrl,
    }) !== null
  );
}

// Transcribe and diarize in parallel, then merge speaker labels into the text.
// Shared by the single-file flow and the batch queue. `durationSeconds` (when the
// source knows it, e.g. URL downloads) beats inferring duration from segments.
export async function transcribeFileWithSpeakers(
  filePath: string,
  cfg: FileTranscriptionConfig,
  diarization: DiarizationSettings,
  durationSeconds?: number | null,
  opts: FileTranscriptionOptions = {}
): Promise<FileTranscriptionResult> {
  const byokDiarize = shouldUseByokDiarize(cfg, diarization.enabled);
  const plan = resolveFileTranscriptionPlan(cfg, byokDiarize);
  if (plan.kind === "error") {
    return { ...plan.result, durationSeconds: durationSeconds || null };
  }
  const diarizePromise =
    diarization.enabled && diarization.localModelsReady && !byokDiarize
      ? (window.electronAPI
          .diarizeAudioFile?.(
            filePath,
            {
              numSpeakers: diarization.numSpeakers ?? undefined,
              requestId: opts.requestId,
            },
            plan.authorizationContext
          )
          .catch(() => null) ?? Promise.resolve(null))
      : Promise.resolve(null);

  const [transcribed, diar] = await Promise.all([
    transcribeFileUsingPlan(filePath, cfg, byokDiarize, opts, plan),
    diarizePromise,
  ]);

  // The diarizer measures the converted audio, so it covers picked files whose
  // duration the caller never knew. 0/NaN mean "unknown", hence ||.
  const measuredDuration = durationSeconds || (diar?.success && diar.durationSeconds) || null;
  const result = { ...transcribed, durationSeconds: measuredDuration };

  if (!result.success || !result.text || result.diarized) return result;
  if (!diar?.success || !diar.segments?.length) return result;

  try {
    const merged = await window.electronAPI.mergeSpeakerText?.(
      diar.segments,
      result.text,
      durationSeconds || 0
    );
    if (merged?.success && merged.text) return { ...result, text: merged.text };
  } catch {
    // Merge failure falls back to the plain transcript.
  }
  return result;
}
