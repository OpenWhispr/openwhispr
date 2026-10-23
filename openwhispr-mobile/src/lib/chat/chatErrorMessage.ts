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

const ORGANIZATION_POLICY_PREFIX = 'Your organization';

// On-device requests never touch the network, so none of them reads as a connection problem.
// LOCAL_REASONING_UNAVAILABLE carries copy written from the device's readiness (Apple Intelligence
// off, model still downloading, ...) that says what to do, so it is shown as is.
const toLocalReasoningMessage = (error: LocalReasoningError): string => {
  if (error.code === 'APPLE_LLM_UNSUPPORTED_LANGUAGE') return UNSUPPORTED_LANGUAGE_MESSAGE;
  if (error.code === 'LOCAL_REASONING_UNAVAILABLE' && error.message.trim()) return error.message;
  return CHAT_ON_DEVICE_UNAVAILABLE_MESSAGE;
};

// Provider and network errors carry raw text that means nothing to the user, so only the cases
// with something to act on get their own copy; timeouts, fetch failures and the rest read as a
// connection problem.
export const toChatErrorMessage = (error: unknown): string => {
  if (isLocalContextLimitError(error)) return CHAT_CONTEXT_LIMIT_MESSAGE;
  if (error instanceof LocalReasoningError) return toLocalReasoningMessage(error);
  if (error instanceof Error && error.message.startsWith(ORGANIZATION_POLICY_PREFIX)) {
    return error.message;
  }
  if (error instanceof Error && error.message === UPGRADE_REQUIRED_MESSAGE) return error.message;
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
