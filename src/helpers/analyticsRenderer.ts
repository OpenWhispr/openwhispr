import type { AnalyticsMode } from "../types/electron";

// Main runs CommonJS directly while the renderer is bundled as ESM. Keep this
// small runtime-boundary adapter aligned with analytics.cjs.
export function localDateKey(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function resolveAnalyticsMode({
  useLocalWhisper,
  transcriptionMode,
  cloudTranscriptionMode,
}: {
  useLocalWhisper?: boolean;
  transcriptionMode?: string;
  cloudTranscriptionMode?: string;
}): AnalyticsMode {
  if (useLocalWhisper || transcriptionMode === "local") return "local";
  if (transcriptionMode === "self-hosted") return "self_hosted";
  if (cloudTranscriptionMode === "openwhispr" || transcriptionMode === "openwhispr") {
    return "openwhispr_cloud";
  }
  if (transcriptionMode === "providers") return "byok";
  return "unknown";
}

export function modeFromStoredProvider(provider?: string | null): AnalyticsMode {
  if (!provider) return "unknown";
  if (provider.startsWith("local")) return "local";
  if (provider === "openwhispr") return "openwhispr_cloud";
  if (provider.includes("self-hosted") || provider === "lan") return "self_hosted";
  return "byok";
}
