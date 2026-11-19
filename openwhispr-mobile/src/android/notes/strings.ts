import i18n from '../strings';
import { useTranslation } from 'react-i18next';

// Notes copy lives here rather than in the shared locale files, which the iOS app loads.
// English only for now, like the rest of the Android copy; other languages fall back to it.
export const notesEnglish = {
  notes: 'Notes',
  back: 'Back',
  search: 'Search',
  searchNotes: 'Search notes',
  searchIn: 'Search {{place}}',
  new: 'New',
  recent: 'Recent',
  private: 'Private',
  onlyYou: 'Only you',
  folders: 'Folders',
  untitled: 'Untitled',
  today: 'Today',
  yesterday: 'Yesterday',
  folderCount: '{{count}} notes',
  // Empty
  tapToRecord: 'Tap to record a meeting',
  tapToRecordBody: 'You’ll get a summary and who said what.',
  writeNote: 'Write a note',
  uploadAudio: 'Upload audio',
  emptyFolder: 'Nothing in {{folder}} yet',
  emptyFolderBody: 'New notes you start here are filed in this folder.',
  // Space switcher
  showNotesFrom: 'Show notes from',
  allSpaces: 'All spaces',
  allSpacesBody: 'Private and every teamspace',
  people: '{{count}} people',
  people_one: '1 person',
  // Note rows
  kindMeeting: 'Meeting',
  kindUpload: 'Upload',
  kindNote: 'Note',
  minutes: '{{count}} min',
  noText: 'No text yet',
  // Select
  selected: '{{count}} selected',
  move: 'Move',
  share: 'Share',
  delete: 'Delete',
  close: 'Close',
  select: 'Select',
  // Delete
  deleted: '“{{title}}” deleted',
  deletedMany: '{{count}} notes deleted',
  undo: 'Undo',
  // New sheet
  recordMeeting: 'Record a meeting',
  recordMeetingBody: 'Summary, action items and speakers',
  recordEvent: 'Record {{title}}',
  recordAnother: 'Record another meeting',
  writeNoteBody: 'Type, or dictate with the bubble',
  uploadAudioBody: 'WAV, MP3, M4A, AAC, OGG or WEBM',
  newFolder: 'New folder',
  // Calendar
  upNext: 'Up next',
  now: 'Now',
  inMinutes: 'In {{count}} min',
  moreToday: '{{count}} more today',
  todaySheet: 'Today',
  record: 'Record',
  hideUpNext: 'Hide up next',
  // Search
  recentSearches: 'Recent',
  removeSearch: 'Remove {{query}}',
  clear: 'Clear',
  all: 'All',
  resultCount: '{{count}} notes',
  resultCount_one: '1 note',
  noMatch: 'No notes match “{{query}}”',
  noMatchBody: 'Searched titles, notes, summaries and transcripts in {{place}}.',
  everywhere: 'all spaces',
  matchTitle: 'Title',
  matchNotes: 'Notes',
  matchSummary: 'Summary',
  matchTranscript: 'Transcript',
  // Folder menu
  renameFolder: 'Rename folder',
  deleteFolder: 'Delete folder',
  deleteFolderTitle: 'Delete “{{name}}”?',
  deleteFolderBody: 'The folder and its {{count}} notes will be deleted.',
  deleteFolderEmptyBody: 'The folder will be deleted.',
  cancel: 'Cancel',
} as const;

export type NotesKey = keyof typeof notesEnglish;
export const NOTES_NAMESPACE = 'androidNotes';
i18n.addResourceBundle('en', NOTES_NAMESPACE, notesEnglish, true, false);

export type NotesT = (key: NotesKey, options?: Record<string, unknown>) => string;

export function useNotesT(): NotesT {
  const { t } = useTranslation(NOTES_NAMESPACE);
  return t as NotesT;
}

export const notesT: NotesT = (key, options) =>
  i18n.t(key, { ns: NOTES_NAMESPACE, ...options }) as string;
