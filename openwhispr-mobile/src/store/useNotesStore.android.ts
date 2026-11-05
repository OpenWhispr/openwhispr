import { createAndroidNotesStore } from '@/android/notesStore';

export type { CreateMeetingNoteContext } from './createNotesStore';
export const useNotesStore = createAndroidNotesStore();
