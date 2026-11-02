import { createNotesStore } from './createNotesStore';

export type { CreateMeetingNoteContext } from './createNotesStore';
export const useNotesStore = createNotesStore();
