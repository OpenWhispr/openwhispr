import { withSessionRefresh } from "../lib/auth";
import { resolveTranscriptionRoute } from "../helpers/transcriptionRoute";
import { getTranscriptionProviders } from "../models/ModelRegistry";
import type { LocalTranscriptionProvider } from "../types/electron";

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
  cohereModel: string;
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
  geminiApiKey: string;
  tinfoilApiKey: string;
  customTranscriptionApiKey?: string;
}

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
    case "gemini":
      return keys.geminiApiKey;
    case "tinfoil":
      return keys.tinfoilApiKey;
    case "custom":
      return keys.customTranscriptionApiKey || "";
    default:
      return "";
  }
}

// Single provider dispatch shared by the single-file flow and the batch queue,
// so BYOK providers receive identical options in both.
export async function transcribeFile(
  filePath: string,
  cfg: FileTranscriptionConfig,
  diarize: boolean,
  opts: { requestId?: string; timestamps?: boolean } = {}
): Promise<FileTranscriptionResult> {
  if (cfg.isOpenWhisprCloud) {
    return withSessionRefresh(async () => {
      const r = await window.electronAPI.transcribeAudioFileCloud!(filePath, opts);
      if (!r.success && r.code) {
        throw Object.assign(new Error(r.error || "Cloud transcription failed"), {
          code: r.code,
        });
      }
      return r;
    });
  }

  if (cfg.useLocalWhisper) {
    const provider = cfg.localTranscriptionProvider as LocalTranscriptionProvider;
    return window.electronAPI.transcribeAudioFile(filePath, {
      provider,
      model:
        provider === "nvidia"
          ? cfg.parakeetModel
          : provider === "cohere"
            ? cfg.cohereModel
            : cfg.whisperModel,
      // Only Cohere consumes it (no auto-detect); passing it to whisper would
      // override its auto language detection.
      ...(provider === "cohere" && cfg.language ? { language: cfg.language } : {}),
      requestId: opts.requestId,
    });
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
    return { success: false, error: route.message, code: route.code };
  }

  // Self-hosted fields make the handler route to the configured server
  // (fail-closed on misconfiguration) instead of stale BYOK settings.
  return window.electronAPI.transcribeAudioFileByok!({
    filePath,
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
  });
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
    (cfg.cloudTranscriptionProvider === "openai" || cfg.cloudTranscriptionProvider === "mistral")
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
  opts: { requestId?: string; timestamps?: boolean } = {}
): Promise<FileTranscriptionResult> {
  const byokDiarize = shouldUseByokDiarize(cfg, diarization.enabled);
  const diarizePromise =
    diarization.enabled && diarization.localModelsReady && !byokDiarize
      ? (window.electronAPI
          .diarizeAudioFile?.(filePath, {
            numSpeakers: diarization.numSpeakers ?? undefined,
            requestId: opts.requestId,
          })
          .catch(() => null) ?? Promise.resolve(null))
      : Promise.resolve(null);

  const [transcribed, diar] = await Promise.all([
    transcribeFile(filePath, cfg, byokDiarize, opts),
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
