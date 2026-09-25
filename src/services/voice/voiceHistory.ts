const HISTORY_LIMIT = 20;
// Old messages leave in blocks, not one per turn: every drop changes the start of
// the prompt and forces a full re-read, so it should happen once per ~5 turns.
const HISTORY_DROP_STEP = 10;

function windowStart(messages: StoredMessage[]): number {
  const overflow = messages.length - HISTORY_LIMIT;
  if (overflow <= 0) return 0;
  let start = Math.ceil(overflow / HISTORY_DROP_STEP) * HISTORY_DROP_STEP;
  while (start < messages.length && messages[start].role !== "user") start += 1;
  return start;
}

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
  const recent = messages.slice(windowStart(messages));
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
