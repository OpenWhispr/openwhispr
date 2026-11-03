import { createNoteEditorScreen } from './NoteEditorCore';
import { androidNoteEditor } from '@/android/noteEditor';
export { isAudioTranscriptNote } from './NoteEditorCore';
export type { NoteEditorStack } from './NoteEditorCore';

export default createNoteEditorScreen(androidNoteEditor);
