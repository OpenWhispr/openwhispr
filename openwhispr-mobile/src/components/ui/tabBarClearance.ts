import { Platform } from 'react-native';

// Approximate height of the floating NativeTabs bar (incl. home-indicator inset). Tab screens draw
// under it, so content pinned to their bottom sits this far up.
export const TAB_BAR_CLEARANCE = Platform.OS === 'ios' ? 110 : 70;

// Static routes inside the (notes) stack — anything else under (notes) is the
// dynamic [id] editor route.
const NOTES_STATIC_ROUTES = new Set(['index', 'notes', 'actions']);
// Static routes inside the (chat) stack; anything else is a conversation, or a note opened
// from one.
const CHAT_STATIC_ROUTES = new Set(['index', 'history']);

/**
 * Whether the floating tab bar is hidden: on the note editor, on a chat detail, or during the
 * keyboard-dictation handoff takeover. Shared so floating UI can sit where the bar is not.
 */
export function isTabBarHidden(segments: readonly string[], handoffActive: boolean): boolean {
  const isNoteEditor =
    segments[1] === '(notes)' && segments[2] !== undefined && !NOTES_STATIC_ROUTES.has(segments[2]);
  const isChatDetail =
    segments[1] === '(chat)' && segments[2] !== undefined && !CHAT_STATIC_ROUTES.has(segments[2]);
  return isNoteEditor || isChatDetail || handoffActive;
}
