import reasoningService from "../services/ReasoningService";

const TITLE_SYSTEM_PROMPT =
  "Generate a concise 3-8 word title for these notes. Return ONLY the title text, nothing else — no quotes, no prefix, no explanation.";

export async function generateNoteTitle(text: string, modelId: string): Promise<string> {
  try {
    const raw = await reasoningService.processText(text.slice(0, 2000), modelId, null, {
      systemPrompt: TITLE_SYSTEM_PROMPT,
      temperature: 0.3,
    });
    const cleaned = raw.trim().replace(/^["']|["']$/g, "");
    return cleaned.length > 0 && cleaned.length < 100 ? cleaned : "";
  } catch {
    return "";
  }
}
