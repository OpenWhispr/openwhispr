// Fork-owned defaults, applied only where no stored user setting exists.
// With the hosted cloud disabled, nothing may default to an "openwhispr" route:
// transcription defaults to the Custom provider pointing at our STT API.
import { CLOUD_ENABLED, DEFAULT_STT } from "./forkRuntime.ts";

export function resolveForkDefaults(cloudEnabled: boolean, stt = DEFAULT_STT) {
  return {
    inferenceMode: cloudEnabled ? "openwhispr" : "providers",
    cloudMode: cloudEnabled ? "openwhispr" : "byok",
    transcriptionProvider: cloudEnabled ? null : "custom",
    transcriptionModel: cloudEnabled ? null : stt.model,
    transcriptionBaseUrl: cloudEnabled ? null : stt.baseUrl,
    // Cleanup runs on our server too (POST <stt>/chat/completions with the license
    // bearer). A full /chat/completions path, so the Custom provider goes straight
    // to chat completions and never probes /models or /responses.
    cleanupProvider: cloudEnabled ? null : "custom",
    cleanupBaseUrl: cloudEnabled ? null : `${stt.baseUrl.replace(/\/+$/, "")}/chat/completions`,
    // Display only: the server pins the cleanup model.
    cleanupModel: cloudEnabled ? null : "haiku",
    // A stored "openwhispr" route cannot work without a backend.
    coerceInferenceMode: (value: string) =>
      !cloudEnabled && value === "openwhispr" ? "providers" : value,
    coerceCloudMode: (value: string) => (!cloudEnabled && value === "openwhispr" ? "byok" : value),
  };
}

export const FORK_DEFAULTS = resolveForkDefaults(CLOUD_ENABLED);

/**
 * STT-04: our STT API serves one model; when that model is English-only (registry
 * `language: "en"`) and the user dictates through it, any other fixed language
 * cannot transcribe correctly. Returns true when the language picker should warn.
 */
export function forkSttLanguageMismatch(
  settings: {
    cloudTranscriptionProvider?: string | null;
    cloudTranscriptionBaseUrl?: string | null;
    cloudTranscriptionModel?: string | null;
    preferredLanguage?: string | null;
    useLocalWhisper?: boolean;
  },
  modelLanguage: (model: string) => string | undefined,
  stt = DEFAULT_STT
): boolean {
  if (settings.useLocalWhisper) return false;
  if (settings.cloudTranscriptionProvider !== "custom") return false;
  const host = (url: string | null | undefined) => {
    try {
      return new URL(url || "").hostname.toLowerCase();
    } catch {
      return "";
    }
  };
  if (!host(settings.cloudTranscriptionBaseUrl)) return false;
  if (host(settings.cloudTranscriptionBaseUrl) !== host(stt.baseUrl)) return false;
  const model = settings.cloudTranscriptionModel || stt.model;
  if (modelLanguage(model) !== "en") return false;
  const lang = (settings.preferredLanguage || "auto").toLowerCase();
  return lang !== "auto" && lang !== "en" && !lang.startsWith("en-");
}
