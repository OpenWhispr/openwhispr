import { Sentry } from '@/lib/sentry';

// Required lazily: the chat store reaches SQLite through @/data, which the auth store and the sync
// engine sit underneath. A module that fails to load is reported rather than thrown, so it can't
// leave a sign-out, an account deletion or an account switch half done.
export const withChatHistory = (
  use: (chatHistory: typeof import('@/lib/chat/chatHistory')) => void,
): void => {
  try {
    use(require('@/lib/chat/chatHistory') as typeof import('@/lib/chat/chatHistory'));
  } catch (error) {
    console.warn('[chat] chat history was not loaded:', error);
    Sentry.captureException(error, {
      level: 'warning',
      tags: { feature: 'chat', operation: 'load-history' },
    });
  }
};
