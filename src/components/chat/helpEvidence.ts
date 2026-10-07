import topics from "../../config/productHelpTopics.json";
import type { ToolCallInfo } from "./types";

export interface HelpSource {
  title: string;
  url: string;
  source: "live" | "bundled";
  reason: "policy" | "rateLimit" | "unavailable" | null;
}

export interface HelpEvidenceData {
  sources: HelpSource[];
  facts: Array<{ label: string; value: string }>;
  readAt: string | null;
}

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
  const call = toolCalls
    ?.slice()
    .reverse()
    .find(
      (item) =>
        item.name === "grounded_product_help" &&
        item.status === "completed" &&
        record(item.metadata) &&
        item.metadata.kind === "grounded-help"
    );
  if (!call || !record(call.metadata)) return null;
  const data = call.metadata;
  const sources: HelpSource[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(data.sources) ? data.sources.slice(0, 32) : []) {
    if (!record(item) || typeof item.path !== "string" || !paths.has(item.path)) continue;
    const url = `https://docs.openwhispr.com${item.path}`;
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
          : item.reason === "policy" || item.reason === "rateLimit"
            ? item.reason
            : "unavailable",
    });
  }
  const facts = (Array.isArray(data.facts) ? data.facts.slice(0, 40) : []).flatMap((item) =>
    record(item) && shortText(item.label) && shortText(item.value)
      ? [{ label: item.label, value: item.value }]
      : []
  );
  const readAt =
    typeof data.readAt === "string" &&
    /^\d{4}-\d{2}-\d{2}T/.test(data.readAt) &&
    Number.isFinite(Date.parse(data.readAt))
      ? data.readAt
      : null;
  return { sources, facts, readAt };
}
