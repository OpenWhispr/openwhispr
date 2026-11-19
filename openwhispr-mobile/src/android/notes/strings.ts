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
  // Open note
  summary: 'Summary',
  myNotes: 'Notes',
  transcript: 'Transcript',
  shareNote: 'Share',
  more: 'More',
  titlePlaceholder: 'Title',
  notesPlaceholder: 'Type your notes, or dictate with the bubble',
  copySummary: 'Copy summary',
  copied: 'Copied',
  makeShorter: 'Make shorter',
  makeLonger: 'Make longer',
  writing: 'Writing…',
  noSummary: 'No summary yet',
  noSummaryBody: 'Turn the transcript into decisions, action items and the main points.',
  noSummaryBodyNote: 'Turn your notes into a clean summary with the main points.',
  writeSummary: 'Write summary',
  templateLabel: 'Template: {{name}}',
  noTextModel: 'Download a text model in Settings → Processing',
  writeSummaryAs: 'Write the summary as',
  templatesFooter: 'Make and edit templates on desktop.',
  rewriteSummary: 'Rewrite summary',
  rewrittenAs: 'Summary rewritten as {{name}}',
  shortened: 'Summary shortened',
  lengthened: 'Summary lengthened',
  summaryWritten: 'Summary written',
  copyTranscript: 'Copy transcript',
  isThis: 'Is this {{name}}?',
  noTranscript: 'No transcript yet.',
  done: 'Done',
  bold: 'Bold',
  italic: 'Italic',
  bullet: 'Bullet',
  checklist: 'Checklist',
  heading: 'Heading',
  // Meta
  inCalendar: '{{title}} · Google',
  attendees: 'People',
  moreAttendees: '{{count}} more',
  // Menu
  linkAndPeople: 'Link and people',
  export: 'Export',
  exportBody: 'Markdown, text, or send to an app',
  moveToFolder: 'Move to folder',
  backUpNote: 'Back up this note',
  deleteNote: 'Delete note',
  // Share & export
  anyoneWithLink: 'Anyone with the link',
  canView: 'Can view',
  shareALink: 'Share a link',
  shareALinkBody: 'Choose who can open it',
  signInToShare: 'Sign in to share a link',
  peopleWithAccess: 'People with access',
  peopleBody: 'Invite people and change access',
  copy: 'Copy',
  exportLabel: 'Export',
  sendToApp: 'Send to an app',
  sendToAppBody: 'Gmail, Slack, Docs… (Android share)',
  saveMarkdown: 'Save as Markdown',
  saveMarkdownBody: '.md file to share or save',
  // Cloud once
  cloudTitle: 'Write the summary on Cloud?',
  cloudBodyLocal:
    'You’re on Local Mode and this phone has no text model. Writing the summary sends this note to OpenWhispr Cloud once. Nothing else changes.',
  cloudBodyPrivate:
    'This note isn’t backed up. Writing the summary sends it to OpenWhispr Cloud once. Its privacy and backup don’t change.',
  useCloudOnce: 'Use Cloud this once',
  downloadTextModel: 'Download a text model',
  // Start sheet (R0)
  noEvent: 'No calendar event',
  noEventBody: 'Name it yourself afterwards',
  liveOnCloud: 'Live on Cloud',
  liveOnCloudBody: 'Words appear as people talk',
  onPhone: 'On this phone',
  onPhoneBody: 'Afterwards · speakers named',
  change: 'Change',
  startRecording: 'Start recording',
  startFooter: 'Ask before you record people. The phone keeps recording with the screen off.',
  needsSpeechModel: 'Download a speech model first',
  needsSpeechModelBody: 'Recording on this phone needs one. Settings → Processing',
  pickEvent: 'Which meeting?',
  // Recording (R1)
  recording: 'Recording · {{time}}',
  reconnecting: 'Reconnecting · {{time}}',
  liveTranscript: 'Live transcript',
  listening: 'Listening…',
  stopAndSave: 'Stop and save',
  minimise: 'Back to notes',
  notesWhileRecording: 'Jot decisions, follow-ups or context while recording…',
  // Upload (U1)
  transcribing: 'Transcribing',
  cleaningUp: 'Writing it up',
  stayOnScreen: 'Keep this screen open until it’s done.',
  cancelUpload: 'Cancel upload',
  uploadFailed: 'Couldn’t turn this audio into a note',
  copyTranscript2: 'Copy what was transcribed',
  tryAgain: 'Try again',
  settingsProcessing: 'Settings → Processing',
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
