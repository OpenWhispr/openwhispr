import { Sentry } from '@/lib/sentry';
import { useChatStore, wipeSavedChats } from '@/store/useChatStore';

const reportFailure = (error: unknown, operation = 'clear-history'): void => {
  console.warn(`[chat] ${operation} failed:`, error);
  Sentry.captureException(error, {
    level: 'warning',
    tags: { feature: 'chat', operation },
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

// A sign-out that keeps the chats still stops the turn that was running, so its answer isn't saved
// after the session that asked for it has gone.
export const stopChatTurn = (): void => {
  try {
    useChatStore.getState().cancel();
  } catch (error) {
    reportFailure(error, 'stop-turn');
  }
};
