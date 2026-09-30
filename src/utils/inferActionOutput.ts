import reasoningService from "../services/ReasoningService";
import { getSettings, selectResolvedNoteFormatting } from "../stores/settingsStore";
import { buildNoteFormattingOverrides } from "../helpers/noteFormattingOverrides";
import { stripThinkingTags } from "../helpers/stripThinking";
import type { ActionOutput } from "../types/electron";

const OUTPUT_SYSTEM_PROMPT = `You sort instructions that a user runs on a meeting note. Reply SUMMARY if the instruction changes the note's AI summary itself: rewrites, shortens, expands, reformats, or translates it, or adds a section to it. Reply CHAT if it produces something separate from the summary, such as an email, a message, a list, an outline, or an answer to a question. Reply with exactly one word: SUMMARY or CHAT.`;

/** Where an action's result belongs, read from its prompt by the note model; chat when it can't tell. */
export async function inferActionOutput(
  prompt: string,
  modelId: string,
  isCloudMode: boolean
): Promise<ActionOutput> {
  try {
    const reply = await reasoningService.processText(prompt.slice(0, 2000), modelId, null, {
      systemPrompt: OUTPUT_SYSTEM_PROMPT,
      temperature: 0,
      // A one-word answer needs no thinking, and a kept <think> block would hide it.
      disableThinking: true,
      ...buildNoteFormattingOverrides(selectResolvedNoteFormatting(getSettings()), isCloudMode),
    });
    // Not every route strips a reasoning model's inline <think> block.
    return /^\W*summary\b/i.test(stripThinkingTags(reply)) ? "summary" : "chat";
  } catch {
    return "chat";
  }
}
