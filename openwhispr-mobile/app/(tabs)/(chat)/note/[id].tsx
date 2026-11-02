import NoteEditorScreen, { type NoteEditorStack } from '@/screens/NoteEditorScreen';
import { CHAT_HOME_ROUTE } from '@/lib/chat/chatRoutes';

// A note opened from a chat stays on the Chat tab's stack, and so do the screens it opens.
const CHAT_NOTE_STACK: NoteEditorStack = {
  root: CHAT_HOME_ROUTE,
  routePrefix: '/(tabs)/(chat)/note',
};

export default function ChatNoteScreen(): React.JSX.Element {
  return <NoteEditorScreen stack={CHAT_NOTE_STACK} />;
}
