import type { ChatVoiceInput } from '@/hooks/useChatVoiceInput';
import type { ChatPending } from '@/store/useChatStore';
import type { ChatConversationSummary } from './types';

/**
 * Whether the pending turn or transcription belongs to the screen showing `conversationId` (null
 * for Home or a new chat). A pending entry with no conversation is a question still transcribing,
 * and Home and every new chat share that id, so only the screen whose voice is transcribing owns it.
 */
export const ownsChatPending = (
  pending: ChatPending | null,
  conversationId: string | null,
  voiceState: ChatVoiceInput['state'],
): boolean =>
  pending !== null &&
  pending.conversationId === conversationId &&
  (conversationId !== null || voiceState === 'transcribing');

/** The title of the conversation the pending turn belongs to, for a store selector. */
export const selectPendingTitle = (state: {
  conversations: ChatConversationSummary[];
  pending: ChatPending | null;
}): string | undefined =>
  state.conversations.find((conversation) => conversation.id === state.pending?.conversationId)
    ?.title;

export const workingElsewhereLabel = (title: string | undefined): string =>
  title ? `Working on “${title}”…` : 'Working on your question…';

/** Said when a send was refused because saved chats from a failed wipe are still being cleared. */
export const SEND_BLOCKED_NOTICE = 'Couldn’t send right now. Try again.';
