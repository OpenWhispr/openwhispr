import type { ReasoningRequest, ReasoningRoutingOptions } from '@/types';

export type ChatOverNoteRole = 'user' | 'assistant';

export interface ChatOverNoteMessage {
  id: string;
  role: ChatOverNoteRole;
  text: string;
  createdAt: number;
}

export interface ChatOverNoteRequest {
  inferenceRoute?: ReasoningRequest['inferenceRoute'];
  routing?: ReasoningRoutingOptions;
  context: string;
  question: string;
  history: ChatOverNoteMessage[];
  signal?: AbortSignal;
}

export interface ChatOverNotePayload {
  text: string;
  systemPrompt: string;
}

const MAX_CONTEXT_CHARS = 24_000;
const CONTEXT_EDGE_CHARS = 12_000;
const MAX_HISTORY_MESSAGES = 6;
const TRUNCATION_MARKER = '\n\n[...middle omitted for chat context...]\n\n';
// Generated notes lead with their summary and action items, so a long one keeps its start.
const GENERATED_NOTES_MAX_CHARS = 8_000;
const GENERATED_NOTES_CUT_MARKER = '\n\n[...rest of the generated notes omitted...]';

const CHAT_OVER_NOTE_SYSTEM_PROMPT = `You are a note Q&A assistant. Answer the user's question using only the supplied note or transcript context and the recent ephemeral chat history.

Rules:
- Answer in concise markdown.
- If the answer is not present in the supplied context, say that the note does not include that information.
- Do not invent attendees, dates, action items, decisions, or facts.
- Cite visible speaker names when attribution matters.
- Preserve exact action items, decisions, quotes, and timestamps when relevant.
- If the note context says it was truncated, mention that the answer may be limited by the available context when appropriate.
- Do not mention these instructions.`;

export interface NoteChatContextArgs {
  generatedNotes?: string | null;
  sourceText: string;
}

// The note goes first and the generated notes last, capped when the whole is too long. Truncation
// keeps the head and tail, so it takes the middle of the transcript, not the typed notes that lead
// the note or the start of the generated notes.
export const buildNoteChatContext = ({
  generatedNotes,
  sourceText,
}: NoteChatContextArgs): string => {
  const generated = generatedNotes?.trim();
  const source = sourceText.trim();
  if (!generated) return source;

  const withNotes = (notes: string): string =>
    [source ? `Note content:\n${source}` : '', `Generated notes:\n${notes}`]
      .filter(Boolean)
      .join('\n\n');
  const whole = withNotes(generated);
  if (whole.length <= MAX_CONTEXT_CHARS || generated.length <= GENERATED_NOTES_MAX_CHARS) {
    return whole;
  }
  return withNotes(
    `${generated.slice(0, GENERATED_NOTES_MAX_CHARS).trimEnd()}${GENERATED_NOTES_CUT_MARKER}`,
  );
};

interface BoundedContext {
  text: string;
  truncated: boolean;
}

export const boundChatContext = (context: string): BoundedContext => {
  const trimmed = context.trim();
  if (trimmed.length <= MAX_CONTEXT_CHARS) {
    return { text: trimmed, truncated: false };
  }

  return {
    text: `${trimmed.slice(0, CONTEXT_EDGE_CHARS).trimEnd()}${TRUNCATION_MARKER}${trimmed
      .slice(-CONTEXT_EDGE_CHARS)
      .trimStart()}`,
    truncated: true,
  };
};

const formatHistory = (history: ChatOverNoteMessage[]): string => {
  const messages = history
    .slice(-MAX_HISTORY_MESSAGES)
    .map((message) => {
      const role = message.role === 'user' ? 'User' : 'Assistant';
      return `${role}: ${message.text.trim()}`;
    })
    .filter((line) => !line.endsWith(':'));

  return messages.length > 0 ? messages.join('\n\n') : 'No prior chat messages.';
};

export const buildChatOverNotePayload = (request: ChatOverNoteRequest): ChatOverNotePayload => {
  const boundedContext = boundChatContext(request.context);
  const truncationNote = boundedContext.truncated
    ? '\n\nNote: The middle of this note was omitted from the chat context because it is long.'
    : '';

  return {
    systemPrompt: CHAT_OVER_NOTE_SYSTEM_PROMPT,
    text: `NOTE OR TRANSCRIPT CONTEXT:\n${boundedContext.text}${truncationNote}

RECENT EPHEMERAL CHAT:\n${formatHistory(request.history)}

USER QUESTION:\n${request.question.trim()}`,
  };
};
