import { LocalChatRepository } from '@/android/shared/data/local/chatRepository';
import { LocalNotesRepository } from '@/android/data/notesRepository';
import { calendarRepository } from '@/android/shared/data/calendarRepository';
import { spacesRepository } from '@/android/shared/data/spacesRepository';
import { SyncedNotesRepository } from '@/android/shared/data/synced/SyncedNotesRepository';
import type { NotesRepository } from '@/data/types';
import type { CalendarRepository } from '@/data/calendarTypes';

export const notesRepository: NotesRepository = new SyncedNotesRepository(
  new LocalNotesRepository(),
);
export const chatRepository = new LocalChatRepository();
export { calendarRepository };
export { spacesRepository };
export type {
  NotesRepository,
  Note,
  Folder,
  Action,
  NoteUpdate,
  ActionUpdate,
  RemoteFolder,
  RemoteNote,
  RemoteNoteCreateResult,
  ConflictedNote,
  ChatCandidateNotes,
  ChatCandidateOptions,
  ChatNoteWindow,
} from '@/data/types';
export type {
  CalendarParticipant,
  CalendarRepository,
  GoogleCalendar,
  GoogleCalendarAccount,
  GoogleCalendarAccountStatus,
  GoogleCalendarEvent,
  GoogleCalendarSyncState,
  UpsertGoogleCalendarAccountInput,
  UpsertGoogleCalendarEventInput,
  UpsertGoogleCalendarInput,
} from '@/data/calendarTypes';
export type {
  RemoteSpace,
  Space,
  SpaceKind,
  SpaceMyRole,
  SpaceSyncStatus,
  SpacesRepository,
} from '@/data/spacesTypes';
