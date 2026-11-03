/** The `[id]` param of a chat that has no conversation yet. */
export const NEW_CHAT_ID = 'new';

export const CHAT_HOME_ROUTE = '/(tabs)/(chat)';
export const CHAT_HISTORY_ROUTE = '/(tabs)/(chat)/history';

export const chatConversationRoute = (conversationId: string): `/(tabs)/(chat)/${string}` =>
  `/(tabs)/(chat)/${conversationId}`;

/** A note opened from a chat, pushed on the Chat tab's own stack so Back returns to the chat. */
export const chatNoteRoute = (noteId: number): `/(tabs)/(chat)/note/${number}` =>
  `/(tabs)/(chat)/note/${noteId}`;

export const CHAT_SETTINGS_ROUTE = '/(account)/ai-workflow?scope=noteChat';
