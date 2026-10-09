type ChatMessage = { role: string; content: string | Array<unknown> };
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Keep recent passages without replaying every page during an active tool loop. */
export function compactTranscriptHistory<T extends ChatMessage>(messages: T[]): T[] {
  let retained = 0;
  return messages
    .slice()
    .reverse()
    .map((message) => {
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
          if (!isRecord(value) || value.transcript_only !== true || ++retained <= 2) return part;
          const omitted = { id: value.id, transcript_omitted: true };
          return {
            ...part,
            output: {
              ...output,
              value: output.type === "text" ? JSON.stringify(omitted) : omitted,
            },
          };
        })
        .slice()
        .reverse();
      return { ...message, content };
    })
    .slice()
    .reverse();
}
