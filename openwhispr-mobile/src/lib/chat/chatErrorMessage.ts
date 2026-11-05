import {
  isLocalContextLimitError,
  LocalReasoningError,
  UNSUPPORTED_LANGUAGE_MESSAGE,
} from '@/lib/localReasoning';
import { UPGRADE_REQUIRED_MESSAGE } from '@/lib/policyMessages';

export const CHAT_CONNECTION_ERROR_MESSAGE = 'Check your connection and try again.';
export const CHAT_ON_DEVICE_UNAVAILABLE_MESSAGE = 'On-device AI isn’t available right now.';
export const CHAT_CONTEXT_LIMIT_MESSAGE =
  'This question needs more context than on-device AI can handle. Try a shorter question or start a new chat.';
// Note chat has already retried with less of the note by then, so the note itself is what's too big.
export const NOTE_CHAT_CONTEXT_LIMIT_MESSAGE = 'This note is too long for on-device AI.';
export const CHAT_GUARDRAIL_MESSAGE =
  'On-device AI declined to answer this. Try rephrasing your question.';
export const CHAT_OUTPUT_LIMIT_MESSAGE =
  'The answer was too long for on-device AI. Try a narrower question.';
export const CHAT_NOTES_READ_ERROR_MESSAGE = 'Couldn’t read your notes. Try again.';
export const CHAT_EMPTY_ANSWER_MESSAGE = 'The answer came back empty. Try again.';
export const CHAT_SESSION_EXPIRED_MESSAGE = 'Your session expired. Sign in again to keep chatting.';
export const CHAT_RATE_LIMITED_MESSAGE = 'You’ve reached a usage limit. Try again later.';
export const CHAT_SERVER_ERROR_MESSAGE = 'OpenWhispr couldn’t answer right now. Try again.';
export const CHAT_REQUEST_FAILED_MESSAGE = 'OpenWhispr couldn’t take this question. Try again.';

const ORGANIZATION_POLICY_PREFIX = 'Your organization';

/** The turn couldn't search or read the notes on this phone, so nothing left it. */
export class ChatNotesReadError extends Error {
  readonly cause?: unknown;

  constructor(cause?: unknown) {
    super('Could not read notes for chat');
    this.name = 'ChatNotesReadError';
    this.cause = cause;
  }
}

/** The model answered with nothing to show (only its thinking, say), so the turn can be retried. */
export class ChatEmptyAnswerError extends Error {
  constructor() {
    super('Chat answer was empty');
    this.name = 'ChatEmptyAnswerError';
  }
}

// Read by shape rather than instanceof, so this module doesn't pull the API client, and with it
// the auth store, into everything that words a chat error.
const apiErrorStatus = (error: unknown): number | null => {
  if (!(error instanceof Error) || error.name !== 'ApiError') return null;
  const { status } = error as Error & { status?: unknown };
  return typeof status === 'number' ? status : null;
};

// The server answered, so the connection is fine: what went wrong is said instead.
const toApiErrorMessage = (status: number): string => {
  if (status === 401) return CHAT_SESSION_EXPIRED_MESSAGE;
  if (status === 429) return CHAT_RATE_LIMITED_MESSAGE;
  if (status >= 500) return CHAT_SERVER_ERROR_MESSAGE;
  return CHAT_REQUEST_FAILED_MESSAGE;
};

export interface ChatErrorMessageOptions {
  surface?: 'chat' | 'noteChat';
}

// On-device requests never touch the network, so none of them reads as a connection problem.
// LOCAL_REASONING_UNAVAILABLE carries copy written from the device's readiness (Apple Intelligence
// off, model still downloading, ...) that says what to do, so it is shown as is. A guardrail or an
// output limit gives the same answer on a retry, so their copy says what to change instead.
const toLocalReasoningMessage = (error: LocalReasoningError): string => {
  if (error.code === 'APPLE_LLM_UNSUPPORTED_LANGUAGE') return UNSUPPORTED_LANGUAGE_MESSAGE;
  if (error.code === 'APPLE_LLM_GUARDRAIL') return CHAT_GUARDRAIL_MESSAGE;
  if (error.code === 'APPLE_LLM_OUTPUT_LIMIT') return CHAT_OUTPUT_LIMIT_MESSAGE;
  if (error.code === 'LOCAL_REASONING_UNAVAILABLE' && error.message.trim()) return error.message;
  return CHAT_ON_DEVICE_UNAVAILABLE_MESSAGE;
};

// Provider and network errors carry raw text that means nothing to the user, so only the cases
// with something to act on get their own copy; timeouts, fetch failures and the rest read as a
// connection problem. A Cloud error status gets copy of its own, never the server's text.
export const toChatErrorMessage = (
  error: unknown,
  { surface = 'chat' }: ChatErrorMessageOptions = {},
): string => {
  if (isLocalContextLimitError(error)) {
    return surface === 'noteChat' ? NOTE_CHAT_CONTEXT_LIMIT_MESSAGE : CHAT_CONTEXT_LIMIT_MESSAGE;
  }
  if (error instanceof LocalReasoningError) return toLocalReasoningMessage(error);
  if (error instanceof ChatNotesReadError) return CHAT_NOTES_READ_ERROR_MESSAGE;
  if (error instanceof ChatEmptyAnswerError) return CHAT_EMPTY_ANSWER_MESSAGE;
  if (error instanceof Error && error.message.startsWith(ORGANIZATION_POLICY_PREFIX)) {
    return error.message;
  }
  if (error instanceof Error && error.message === UPGRADE_REQUIRED_MESSAGE) return error.message;
  const status = apiErrorStatus(error);
  if (status !== null) return toApiErrorMessage(status);
  // Route refusals and provider rejections are marked as not worth retrying, and their messages
  // say what to fix (a missing key, an unsupported model).
  if (
    error instanceof Error &&
    (error as { retryable?: unknown }).retryable === false &&
    error.message
  ) {
    return error.message;
  }
  return CHAT_CONNECTION_ERROR_MESSAGE;
};
