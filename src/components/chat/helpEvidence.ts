import { DOCS_ORIGIN } from "../../helpers/productHelpFallback.js";
import topics from "../../config/productHelpTopics.json";
import type { ToolCallInfo } from "./types";

export interface HelpSource {
  title: string;
  url: string;
  source: "live" | "bundled";
  reason: "policy" | "rateLimit" | "privacy" | "unavailable" | null;
}

export interface HelpEvidenceData {
  sources: HelpSource[];
  facts: Array<{ key: string; value: string }>;
  readAt: string | null;
}

// Legacy labels are adapted only at the history boundary. New tool metadata stores no settings.
const legacyFactKeys: Record<string, string> = {
  "App version": "appVersion",
  Platform: "platform",
  "Dictation shortcut": "dictationKey",
  "Voice Assistant shortcut": "voiceAgentKey",
  "Translation shortcut": "translationKey",
  "Meeting shortcut": "meetingKey",
  "Activation mode": "activationMode",
  "Microphone selection": "microphoneSelectionMode",
  "Microphone permission": "microphonePermission",
  "Accessibility permission": "accessibilityPermission",
  "System audio permission": "systemAudioPermission",
  "Assistant allowed by policy": "agentAllowed",
  "Chat provider": "chatProvider",
  "Interface language": "uiLanguage",
  "Transcription language": "preferredLanguage",
  "Cloud backup": "cloudBackupEnabled",
  "Google Calendar connected": "gcalConnected",
  "Microsoft Calendar connected": "mcalConnected",
  "Apple Calendar connected": "appleCalendarConnected",
  "Dictation processing": "transcriptionMode",
  "Meeting processing": "meetingTranscriptionMode",
  "Upload processing": "uploadTranscriptionMode",
  "Chat processing": "chatMode",
  "Voice Assistant processing": "voiceAssistantMode",
  "Cleanup processing": "cleanupMode",
  "Dictation engine": "dictationEngine",
  "Meeting engine": "meetingEngine",
  "Upload engine": "uploadEngine",
};
const factKeys = new Set(Object.values(legacyFactKeys));

const paths = new Set(
  Object.values(topics).flatMap((topic) => {
    const extra = (topic as { paths?: string[] }).paths;
    return [topic.path, ...(extra ?? [])];
  })
);
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const shortText = (value: unknown, limit = 200): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= limit;

/** Only app-owned help metadata may produce source links. Never parse model prose. */
export function extractHelpEvidence(toolCalls?: ToolCallInfo[]): HelpEvidenceData | null {
  const calls = toolCalls?.filter(
    (item): item is ToolCallInfo & { metadata: Record<string, unknown> } =>
      item.status === "completed" &&
      record(item.metadata) &&
      ((item.name === "grounded_product_help" && item.metadata.kind === "grounded-help") ||
        (["search_openwhispr_help", "read_openwhispr_help", "get_openwhispr_context"].includes(
          item.name
        ) &&
          item.metadata.kind === "product-help"))
  );
  if (!calls?.length) return null;
  const legacy = [...calls].reverse().find((item) => item.name === "grounded_product_help");
  const data = legacy?.metadata ?? calls[calls.length - 1].metadata!;
  const sources: HelpSource[] = [];
  const seen = new Set<string>();
  for (const item of calls
    .flatMap((call) => (Array.isArray(call.metadata?.sources) ? call.metadata.sources : []))
    .slice(-32)) {
    if (!record(item) || typeof item.path !== "string" || !paths.has(item.path)) continue;
    const url = `${DOCS_ORIGIN}${item.path}`;
    if (item.url !== url || seen.has(url)) continue;
    if (item.source !== "live" && item.source !== "bundled") continue;
    seen.add(url);
    sources.push({
      title: shortText(item.title) ? item.title : item.path,
      url,
      source: item.source,
      reason:
        item.source === "live"
          ? null
          : item.reason === "policy" || item.reason === "rateLimit" || item.reason === "privacy"
            ? item.reason
            : "unavailable",
    });
  }
  const facts = (legacy && Array.isArray(data.facts) ? data.facts.slice(0, 40) : []).flatMap(
    (item) => {
      if (!record(item) || !shortText(item.value)) return [];
      const key = typeof item.key === "string" ? item.key : legacyFactKeys[String(item.label)];
      return factKeys.has(key) ? [{ key, value: item.value }] : [];
    }
  );
  const readAt =
    typeof data.readAt === "string" &&
    /^\d{4}-\d{2}-\d{2}T/.test(data.readAt) &&
    Number.isFinite(Date.parse(data.readAt))
      ? data.readAt
      : null;
  return { sources, facts, readAt };
}
