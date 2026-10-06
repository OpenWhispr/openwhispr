import { LocalNotesRepository } from './local/notesRepository';
import { calendarRepository } from './calendarRepository';
import { spacesRepository } from './spacesRepository';
import { SyncedNotesRepository } from './synced/SyncedNotesRepository';
import type { NotesRepository } from './types';
import type { CalendarRepository } from './calendarTypes';

export const notesRepository: NotesRepository = new SyncedNotesRepository(
  new LocalNotesRepository(),
);
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
} from './types';
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
} from './calendarTypes';
export type {
  RemoteSpace,
  Space,
  SpaceKind,
  SpaceMyRole,
  SpaceSyncStatus,
  SpacesRepository,
} from './spacesTypes';
