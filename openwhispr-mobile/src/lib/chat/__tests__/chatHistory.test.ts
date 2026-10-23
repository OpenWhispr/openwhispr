const mockClearAll = jest.fn();
jest.mock('@/data', () => ({ chatRepository: { clearAll: () => mockClearAll() } }));
jest.mock('@/lib/chat/runChatTurn', () => ({ runChatTurn: jest.fn() }));
jest.mock('@/lib/sentry', () => ({ Sentry: { captureException: jest.fn() } }));

import { Sentry } from '@/lib/sentry';
import { useChatStore } from '@/store/useChatStore';
import { clearChatHistory } from '../chatHistory';

beforeEach(() => jest.clearAllMocks());

describe('clearChatHistory', () => {
  it('resets the store and clears the saved chats', () => {
    useChatStore.setState({ activeConversationId: 'c1' });

    expect(clearChatHistory()).toBe(true);

    expect(useChatStore.getState().activeConversationId).toBeNull();
    expect(mockClearAll).toHaveBeenCalledTimes(1);
  });

  it('logs a failed wipe instead of throwing, so the caller still finishes', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockClearAll.mockImplementationOnce(() => {
      throw new Error('database is locked');
    });

    expect(clearChatHistory()).toBe(false);
    expect(warn).toHaveBeenCalledWith('[chat] chat history was not cleared:', expect.any(Error));
    expect(Sentry.captureException).toHaveBeenCalledWith(expect.any(Error), {
      level: 'warning',
      tags: { feature: 'chat', operation: 'clear-history' },
    });
    warn.mockRestore();
  });
});
