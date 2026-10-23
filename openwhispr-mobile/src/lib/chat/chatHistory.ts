import { Sentry } from '@/lib/sentry';
import { useChatStore, wipeSavedChats } from '@/store/useChatStore';

const reportFailure = (error: unknown): void => {
  console.warn('[chat] chat history was not cleared:', error);
  Sentry.captureException(error, {
    level: 'warning',
    tags: { feature: 'chat', operation: 'clear-history' },
  });
};

// The store goes first: its reset aborts the running turn, so no late answer lands after the wipe.
// Each step runs even when the other fails, and a failure is logged rather than thrown, so it can't
// leave a sign-out, an account deletion or an account switch half done. A saved-chat wipe that
// fails is retried before the chats are read again. Returns whether everything was cleared.
export const clearChatHistory = (): boolean => {
  let cleared = true;
  try {
    useChatStore.getState().reset();
  } catch (error) {
    cleared = false;
    reportFailure(error);
  }
  try {
    wipeSavedChats();
  } catch (error) {
    cleared = false;
    reportFailure(error);
  }
  return cleared;
};
