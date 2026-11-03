import type { InferenceRoute } from '@/lib/mobileProviders';
import {
  countLocalReasoningTokens,
  getLocalInputTokenBudget,
  getLocalReasoningReadiness,
  LocalReasoningError,
} from '@/lib/localReasoning';
import { abortError } from '@/services/providers/NativeProviderTransport';
import { buildChatPayload, type ChatPayload, type ChatPayloadInput } from './chatContext';
import type { ChatMessage } from './types';

export interface ChatBudget {
  local: boolean;
  maxNotes: number;
  inputTokens: number;
  historyTokens: number;
  noteChars: number;
  noteCharCap: number;
  calendarChars: number;
}

// The hosted tokenizer is chosen by the server. This is an application estimate, not a
// provider context guarantee. Non-ASCII text uses its UTF-8 byte count rather than an
// English characters-per-token ratio, including when Apple token counting is unavailable.
export const estimateChatTokens = (text: string): number => {
  let ascii = 0;
  let otherBytes = 0;
  for (const character of text) {
    const point = character.codePointAt(0) ?? 0;
    if (point < 128) ascii += 1;
    else otherBytes += point < 2048 ? 2 : point < 65536 ? 3 : 4;
  }
  return Math.ceil(ascii / 3) + otherBytes;
};

export const resolveChatBudget = async (
  route: InferenceRoute,
  broadRecap: boolean,
): Promise<ChatBudget | null> => {
  // Custom providers have their own model capacities; don't assume a hosted-sized window.
  if (route.mode === 'providers') return null;
  const local = route.mode === 'local';
  const inputTokens = local ? getLocalInputTokenBudget(await getLocalReasoningReadiness()) : 16_000;
  return {
    local,
    maxNotes: local ? 3 : broadRecap ? 20 : 12,
    inputTokens,
    historyTokens: local ? 512 : 2_000,
    noteChars: local ? inputTokens * 3 : 48_000,
    noteCharCap: broadRecap && !local ? 1_500 : 6_000,
    calendarChars: local ? 800 : 4_500,
  };
};

const clipHistoryText = (text: string, tokens: number): string => {
  if (estimateChatTokens(text) <= tokens) return text;
  const characters = Array.from(text);
  let length = Math.min(characters.length, tokens * 3);
  while (length > 0) {
    const clipped = `${characters.slice(0, length).join('')} […]`;
    if (estimateChatTokens(clipped) <= tokens) return clipped;
    length = Math.floor(length * 0.8);
  }
  return '';
};

const boundedHistory = (history: ChatMessage[], tokens: number): ChatMessage[] => {
  const kept: ChatMessage[] = [];
  let remaining = tokens;
  // Keep complete exchanges, newest first, without an orphaned answer from an older turn.
  for (let index = history.length - 1; index > 0 && kept.length < 6; index -= 2) {
    const question = history[index - 1];
    const answer = history[index];
    if (question.role !== 'user' || answer.role !== 'assistant') break;
    const cost = estimateChatTokens(`User: ${question.text}\n\nAssistant: ${answer.text}\n\n`);
    if (cost <= remaining) {
      kept.unshift(question, answer);
      remaining -= cost;
    } else {
      if (kept.length === 0 && remaining >= 64) {
        const each = Math.floor((remaining - 16) / 2);
        kept.push(
          { ...question, text: clipHistoryText(question.text, each) },
          { ...answer, text: clipHistoryText(answer.text, each) },
        );
      }
      break;
    }
  }
  return kept;
};

class ChatInputTooLongError extends Error {
  readonly retryable = false;

  constructor() {
    super('This question is too long for chat. Try a shorter question.');
    this.name = 'ChatInputTooLongError';
  }
}

export const buildBudgetedChatPayload = async (
  input: ChatPayloadInput,
  budget: ChatBudget | null,
  signal: AbortSignal,
): Promise<ChatPayload> => {
  const checkCancelled = (): void => {
    if (signal.aborted) throw abortError('Aborted');
  };
  checkCancelled();
  if (!budget) return buildChatPayload(input);

  const count = async (payload: ChatPayload): Promise<number> => {
    checkCancelled();
    const native = budget.local
      ? await countLocalReasoningTokens({
          instructions: payload.systemPrompt,
          prompt: payload.text,
        })
      : null;
    checkCancelled();
    return native ?? estimateChatTokens(`${payload.systemPrompt}\n\n${payload.text}`);
  };
  let history = boundedHistory(input.history, budget.historyTokens);
  let calendarChars = budget.calendarChars;
  const build = (noteChars: number): ChatPayload =>
    buildChatPayload({
      ...input,
      history,
      noteCharBudget: noteChars,
      noteCharCap: Math.min(budget.noteCharCap, input.noteCharCap ?? Infinity),
      calendarCharBudget: calendarChars,
    });

  let noteChars = Math.min(budget.noteChars, input.noteCharBudget ?? Infinity);
  let payload = build(noteChars);
  let tokens = await count(payload);
  if (tokens < budget.inputTokens) return payload;

  // First reserve space for the current question and the latest exchange. Calendar text
  // and older exchanges are expendable; the current question and instructions are not.
  let base = build(0);
  let baseTokens = await count(base);
  while (baseTokens >= budget.inputTokens && (history.length > 0 || calendarChars > 0)) {
    if (history.length > 2) history = history.slice(2);
    else if (calendarChars > 0) calendarChars = Math.floor(calendarChars / 2);
    else history = [];
    base = build(0);
    baseTokens = await count(base);
  }
  if (baseTokens >= budget.inputTokens) {
    if (budget.local) {
      throw new LocalReasoningError('LOCAL_CONTEXT_LIMIT', 'Question exceeds local context.');
    }
    throw new ChatInputTooLongError();
  }

  // Rebuild complete sections so omitted notes never remain in source metadata. Reduce
  // proportionally, leaving a margin for titles, dates and tokenizer boundary changes.
  payload = build(noteChars);
  tokens = await count(payload);
  while (tokens >= budget.inputTokens && noteChars > 0) {
    const room = budget.inputTokens - baseTokens;
    const noteTokens = Math.max(1, tokens - baseTokens);
    noteChars = Math.floor(noteChars * Math.min(0.8, (room / noteTokens) * 0.9));
    payload = build(noteChars);
    tokens = await count(payload);
  }
  return payload;
};
