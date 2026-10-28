import type { ChatSendGateOptions } from '@/hooks/useChatSendGate';
import type { ProcessingMode } from '@/types';

export const CHAT_TAB_CONSENT_MESSAGE =
  'Chat sends your question, some of your notes and your calendar for up to the next 7 days to your selected AI service for this request. Your privacy and sync settings will not change.';

// Only Local Mode asks before a Chat tab question leaves this iPhone.
export const chatTabGateOptions = (activeMode: ProcessingMode): ChatSendGateOptions => ({
  consentMessage: activeMode === 'private' ? CHAT_TAB_CONSENT_MESSAGE : null,
  source: 'chat_tab',
});
