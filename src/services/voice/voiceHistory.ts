const HISTORY_LIMIT = 20;

interface StoredMessage {
  id: string;
  role: string;
  content: string;
}

export interface VoiceHistoryMessage {
  role: string;
  content: string | Array<Record<string, unknown>>;
}

/**
 * Builds a voice turn's history so every earlier message replays byte-for-byte
 * what the model saw before — the per-turn context (clock, notes) a user message
 * was sent with, and the tool calls and results an assistant turn went through.
 * A local model's prompt cache then only has to read the newest turn.
 * `sentContent` is updated with the newest user message as sent.
 */
export function buildVoiceHistory(
  messages: StoredMessage[],
  sentContent: Map<string, string>,
  turnContext: string,
  wrapWithContext: (text: string, context: string) => string,
  assistantSteps: Map<string, VoiceHistoryMessage[]> = new Map()
): VoiceHistoryMessage[] {
  const recent = messages.slice(-HISTORY_LIMIT);
  let newestUserIndex = -1;
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    if (recent[index].role === "user") {
      newestUserIndex = index;
      break;
    }
  }
  const newestUser = newestUserIndex >= 0 ? recent[newestUserIndex] : null;
  if (newestUser && !sentContent.has(newestUser.id)) {
    sentContent.set(
      newestUser.id,
      turnContext ? wrapWithContext(newestUser.content, turnContext) : newestUser.content
    );
  }
  return recent.flatMap((message) => {
    const steps = message.role === "assistant" ? assistantSteps.get(message.id) : undefined;
    if (steps) return steps;
    return [{ role: message.role, content: sentContent.get(message.id) ?? message.content }];
  });
}
