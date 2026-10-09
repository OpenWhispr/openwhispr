type ChatMessage = { role: string; content: string | Array<unknown> };
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const RETAINED_PASSAGES = 2;

function lastAssistantIndex(messages: ChatMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === "assistant") return index;
  }
  return messages.length;
}

// The passage a get_note transcript read returned, or null for any other part.
function transcriptPassage(part: unknown): Record<string, unknown> | null {
  if (
    !isRecord(part) ||
    part.type !== "tool-result" ||
    part.toolName !== "get_note" ||
    !isRecord(part.output)
  ) {
    return null;
  }
  let value: unknown = part.output.value;
  if (part.output.type === "text" && typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  return isRecord(value) && value.transcript_only === true ? value : null;
}

/**
 * Keep recent passages without replaying every page during an active tool loop.
 * Passages from `latestStepStart` on haven't reached the model yet, so all of
 * them stay; together with them, only the newest RETAINED_PASSAGES are kept.
 * The AI SDK adds each step as one assistant message plus its tool results,
 * which the default finds.
 */
export function compactTranscriptHistory<T extends ChatMessage>(
  messages: T[],
  latestStepStart = lastAssistantIndex(messages)
): T[] {
  const compacted = [...messages];
  let retained = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== "tool" || !Array.isArray(message.content)) continue;
    const content = [...message.content];
    let changed = false;
    for (let partIndex = content.length - 1; partIndex >= 0; partIndex--) {
      const part = content[partIndex] as { output: Record<string, unknown> };
      const passage = transcriptPassage(part);
      if (!passage || ++retained <= RETAINED_PASSAGES || index >= latestStepStart) continue;
      // Where the passage was, so the model can read it again.
      const omitted = {
        id: passage.id,
        transcript_omitted: true,
        transcript_start: passage.transcript_start,
        transcript_end: passage.transcript_end,
      };
      content[partIndex] = {
        ...part,
        output: {
          ...part.output,
          value: part.output.type === "text" ? JSON.stringify(omitted) : omitted,
        },
      };
      changed = true;
    }
    if (changed) compacted[index] = { ...message, content };
  }
  return compacted;
}
