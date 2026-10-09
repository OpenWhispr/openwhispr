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

/**
 * Keep recent passages without replaying every page during an active tool loop.
 * Results from `latestStepStart` on haven't reached the model yet, so all of
 * them stay; older passages are kept, newest first, up to the retained count.
 * The AI SDK adds each step as one assistant message plus its tool results,
 * which the default finds.
 */
export function compactTranscriptHistory<T extends ChatMessage>(
  messages: T[],
  latestStepStart = lastAssistantIndex(messages)
): T[] {
  let retained = 0;
  return messages
    .map((message, index) => ({ message, index }))
    .reverse()
    .map(({ message, index }) => {
      if (message.role !== "tool" || !Array.isArray(message.content)) return message;
      const content = message.content
        .slice()
        .reverse()
        .map((part) => {
          if (
            !isRecord(part) ||
            part.type !== "tool-result" ||
            part.toolName !== "get_note" ||
            !isRecord(part.output)
          )
            return part;
          const output = part.output;
          let value: unknown = output.value;
          if (output.type === "text" && typeof value === "string") {
            try {
              value = JSON.parse(value);
            } catch {
              return part;
            }
          }
          if (!isRecord(value) || value.transcript_only !== true) return part;
          if (++retained <= RETAINED_PASSAGES || index >= latestStepStart) return part;
          // Where the passage was, so the model can read it again.
          const omitted = {
            id: value.id,
            transcript_omitted: true,
            transcript_start: value.transcript_start,
            transcript_end: value.transcript_end,
          };
          return {
            ...part,
            output: {
              ...output,
              value: output.type === "text" ? JSON.stringify(omitted) : omitted,
            },
          };
        })
        .reverse();
      return { ...message, content };
    })
    .reverse();
}
