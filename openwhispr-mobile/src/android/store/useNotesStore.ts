import { createAndroidNotesStore } from '@/android/notesStore';

export type { CreateMeetingNoteContext } from '@/android/store/createNotesStore';
export const useNotesStore = createAndroidNotesStore();
