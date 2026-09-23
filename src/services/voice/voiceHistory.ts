const HISTORY_LIMIT = 20;

interface StoredMessage {
  id: string;
  role: string;
  content: string;
}

export interface VoiceHistoryMessage {
  role: string;
  content: string;
}

/**
 * Builds a voice turn's history so every earlier user message replays
 * byte-for-byte what the model saw before, including the per-turn context
 * (clock, notes) it was sent with. A local model's prompt cache then only has
 * to read from the previous answer onward instead of from the previous question.
 * `sentContent` is updated with the newest user message as sent.
 */
export function buildVoiceHistory(
  messages: StoredMessage[],
  sentContent: Map<string, string>,
  turnContext: string,
  wrapWithContext: (text: string, context: string) => string
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
  return recent.map((message) => ({
    role: message.role,
    content: sentContent.get(message.id) ?? message.content,
  }));
}
