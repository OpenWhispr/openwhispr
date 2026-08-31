import type { CloudModelDefinition } from "../models/ModelRegistry";
import type { ReasoningConfig } from "../services/BaseReasoningService";

export type GeminiThinkingLevel = "minimal" | "low" | "medium" | "high";

interface GeminiResponsePart {
  text?: string;
  thought?: boolean;
}

export interface GeminiUsageMetadata {
  totalTokenCount?: number;
  thoughtsTokenCount?: number;
  candidatesTokenCount?: number;
}

export interface GeminiResponsePayload {
  candidates?: Array<{
    content?: { parts?: GeminiResponsePart[] };
    finishReason?: string;
  }>;
  usageMetadata?: GeminiUsageMetadata;
}

interface GeminiCandidateAssessment {
  kind: "ok" | "truncated" | "empty" | "empty_token_limit";
  text: string;
  finishReason: string;
  usage: GeminiUsageMetadata;
}

type GeminiThinkingPreference = Pick<ReasoningConfig, "disableThinking">;
type GeminiThinkingModelDefinition = Pick<
  CloudModelDefinition,
  "supportsThinking" | "minThinkingLevel"
>;

export interface GeminiThinkingConfig {
  [key: string]: GeminiThinkingLevel | false;
  thinkingLevel: GeminiThinkingLevel;
  includeThoughts: false;
}

const THINKING_LEVELS: readonly GeminiThinkingLevel[] = ["minimal", "low", "medium", "high"];

function isGeminiThinkingLevel(value: unknown): value is GeminiThinkingLevel {
  return THINKING_LEVELS.some((level) => level === value);
}

export function extractGeminiCandidateText(response?: GeminiResponsePayload): {
  text: string;
  finishReason: string;
  usage: GeminiUsageMetadata;
} {
  const candidate = response?.candidates?.[0];
  const parts = candidate?.content?.parts || [];
  const text = parts
    .filter((part) => !part.thought && typeof part.text === "string")
    .map((part) => part.text)
    .join("")
    .trim();
  return {
    text,
    finishReason: candidate?.finishReason || "",
    usage: response?.usageMetadata || {},
  };
}

export function isGeminiTokenLimitHit(finishReason: string | undefined): boolean {
  return finishReason === "MAX_TOKENS";
}

export function assessGeminiResponse(response?: GeminiResponsePayload): GeminiCandidateAssessment {
  const { text, finishReason, usage } = extractGeminiCandidateText(response);
  const tokenLimitHit = isGeminiTokenLimitHit(finishReason);
  if (!text) {
    return { kind: tokenLimitHit ? "empty_token_limit" : "empty", text, finishReason, usage };
  }
  return { kind: tokenLimitHit ? "truncated" : "ok", text, finishReason, usage };
}

export function geminiSuppressedThinkingLevel(
  modelDefinition?: GeminiThinkingModelDefinition
): GeminiThinkingLevel {
  return isGeminiThinkingLevel(modelDefinition?.minThinkingLevel)
    ? modelDefinition.minThinkingLevel
    : "minimal";
}

export function resolveGeminiThinkingConfig(
  config: GeminiThinkingPreference | undefined,
  modelDefinition: GeminiThinkingModelDefinition | undefined
): GeminiThinkingConfig | undefined {
  if (!modelDefinition?.supportsThinking || config?.disableThinking !== true) return undefined;
  return {
    thinkingLevel: geminiSuppressedThinkingLevel(modelDefinition),
    includeThoughts: false,
  };
}
