import { createNoteEditorScreen } from './NoteEditorCore.android';
import { androidNoteEditor } from '@/android/noteEditor';
export { isAudioTranscriptNote } from './NoteEditorCore.android';
export type { NoteEditorStack } from './NoteEditorCore.android';

export default createNoteEditorScreen(androidNoteEditor);
