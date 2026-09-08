import reasoningService from "../services/ReasoningService";
import type { ReasoningConfig } from "../services/BaseReasoningService";
import { getSettings } from "../stores/settingsStore";
import { sanitizeGeneratedTitle } from "./sanitizeGeneratedTitle";

const TITLE_SYSTEM_PROMPT =
  "Generate a concise 3-8 word title for these notes. Return ONLY the title text, nothing else — no quotes, no prefix, no explanation.";

export async function generateNoteTitle(
  text: string,
  modelId: string,
  config?: Pick<ReasoningConfig, "provider" | "baseUrl" | "customApiKey" | "lanUrl">
): Promise<string> {
  try {
    const raw = await reasoningService.processText(text.slice(0, 2000), modelId, null, {
      systemPrompt: TITLE_SYSTEM_PROMPT,
      inferenceScope: "noteFormatting",
      temperature: 0.3,
      disableThinking: getSettings().noteFormattingDisableThinking,
      ...config,
    });
    return sanitizeGeneratedTitle(raw);
  } catch {
    return "";
  }
}
