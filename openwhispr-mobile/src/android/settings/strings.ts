import i18n from '../strings';
import { useTranslation } from 'react-i18next';
import { settingsTranslations } from './translations';

// Settings copy lives here rather than in the shared locale files, which the iOS app loads.
export const settingsEnglish = {
  settings: 'Settings',
  back: 'Back',
  free: 'Free',
  pro: 'Pro',
  trial: 'Trial',
  localWorkspace: 'Local workspace',
  signInToSync: 'Sign in to sync and back up',
  signIn: 'Sign in',
  wordsThisWeek: 'Words this week',
  wordsLeft: '{{words}} left',
  unlimitedWords: 'Unlimited words',
  bubble: 'Bubble',
  showBubble: 'Show bubble',
  sizeLook: 'Size & look',
  holdBubble: 'Hold the bubble',
  holdShowMenu: 'Show the menu',
  holdNothing: 'Nothing',
  holdGroup: 'When you hold the bubble',
  holdFooter:
    'The menu has Assistant, Translate, and Edit selection when text is selected. A tap always dictates.',
  permissions: 'Permissions',
  allOn: 'All on',
  toTurnOn: '{{count}} to turn on',
  dictation: 'Dictation',
  transcription: 'Transcription',
  calendar: 'Calendar',
  notConnected: 'Not connected',
  reconnect: 'Reconnect',
  // Calendar (19.2–19.6)
  googleCalendar: 'Google Calendar',
  googleCalendarBody:
    'See your next meeting on Notes, record it in one tap, and name the note after it.',
  connectGoogle: 'Connect Google Calendar',
  waitingGoogle: 'Waiting for Google…',
  whatWeRead: 'What OpenWhispr reads',
  readTitles: 'Event titles and times',
  readGuests: 'Who’s invited',
  readOnly: 'Read only',
  readOnlyBody: 'Nothing in your calendar is changed or sent.',
  keptSevenDays: 'Events up to 7 days ahead are kept on this phone.',
  accountLabel: 'Account',
  connected: 'Connected',
  signedOutTag: 'Signed out',
  syncedAgo: 'Synced {{when}}',
  notSyncedYet: 'Not synced yet',
  signedOutBody: 'Google signed OpenWhispr out. Reconnect to see Up next on Notes again.',
  syncNow: 'Sync now',
  disconnect: 'Disconnect',
  showEventsFrom: 'Show events from',
  primary: 'Primary',
  addGoogleAccount: 'Add Google account',
  // Calendar · several Google accounts (20.1–20.5)
  accounts: 'Accounts',
  accountsCount: '{{count}} accounts',
  signedOutCount: '{{count}} signed out',
  calendarsOn: '{{on}} of {{total}} calendars on',
  reconnectToSee: 'Reconnect to see its meetings again',
  syncAll: 'Sync all accounts',
  accountsFooter:
    'Up next on Notes shows meetings from every calendar that is on, across all accounts. Events up to 7 days ahead are kept on this phone.',
  accountCalendarsFooter:
    'Turning a calendar off hides its events on Notes. Your other accounts are not affected.',
  signedOutAccountBody:
    'Google signed OpenWhispr out of this account. Reconnect to see its meetings again.',
  otherAccountsStillShow: 'Meetings from your other accounts still show on Notes.',
  disconnectAccountTitle: 'Disconnect {{email}}?',
  disconnectAccountBody:
    'OpenWhispr stops reading this account and removes its events from this phone. Your other accounts stay connected. Notes you already recorded keep their names.',
  accountDisconnected: '{{email}} disconnected',
  calendarFooter:
    'Up next on Notes uses the calendars that are on. Events up to 7 days ahead are kept on this phone.',
  disconnectTitle: 'Disconnect Google Calendar?',
  disconnectBody:
    'OpenWhispr stops reading {{email}} and removes its events from this phone. Notes you already recorded keep their names. Notes will offer to connect again.',
  disconnected: 'Google Calendar disconnected',
  syncFailed: 'Couldn’t sync. Try again.',
  autoRename: 'Auto-rename meetings',
  autoRenameBody:
    'Titles each meeting from what was said. A meeting from your calendar keeps its event name.',
  language: 'Language',
  processing: 'Processing',
  textCleanup: 'Text cleanup',
  textCleanupBody: 'Fix filler words, grammar and lists',
  privacy: 'Privacy',
  keepHistory: 'Keep history',
  cloudBackup: 'Cloud backup',
  cloudBackupBody: 'Saves notes to your account',
  backedUp: 'Backed up {{when}}',
  backupFailed: 'Backup failed · Tap to try again',
  backupOrganization: 'Turned off by your organization',
  analytics: 'Analytics',
  on: 'On',
  off: 'Off',
  plan: 'Plan & billing',
  referral: 'Refer & earn',
  help: 'Help & about',
  signOut: 'Sign out',
  signOutTitle: 'Sign out?',
  signOutBody: 'Your notes stay on this phone. Sign in again to sync them.',
  cancel: 'Cancel',
  notNow: 'Not now',
  openSettings: 'Open settings',
  turnOn: 'Turn on',
  continue: 'Continue',
  ok: 'OK',
  errorTitle: 'Let’s try that again',
  justNow: 'just now',
  minutesAgo: '{{count}} min ago',
  hoursAgo: '{{count}} h ago',
  daysAgo: '{{count}} days ago',
  // Profile
  profile: 'Profile',
  account: 'Account',
  name: 'Name',
  email: 'Email',
  deleteAccount: 'Delete account',
  deleteAccountBody: 'Deletes your account and cloud data',
  createAccount: 'Create account',
  createAccountBody: 'Keep your notes when you change phones',
  // Refer & earn
  linkCopied: 'Link copied',
  inviteSent: 'Invite sent to {{email}}',
  // Show bubble
  micOffTitle: 'Microphone is off',
  micOffBody:
    'The bubble can’t record without it. Turn it on in Android settings, or import an audio file instead.',
  overlayTitle: 'Allow the bubble over other apps',
  overlayBody:
    'The bubble needs Display over other apps to appear in Messages, Gmail and everywhere else.',
  // Cloud backup
  backupSignInTitle: 'Sign in to back up',
  backupSignInBody:
    'Backup keeps your notes and history in your OpenWhispr account. Your notes stay on this phone until you sign in.',
  backupProTitle: 'Cloud backup needs Pro',
  backupProBody: 'Upgrade to back up notes and history to your account.',
  seePlans: 'See plans',
  backupOn: 'Backup on',
  backupOff: 'Backup off',
  // Size & look
  reset: 'Reset',
  bubbleReset: 'Bubble reset',
  size: 'Size',
  small: 'Small',
  medium: 'Medium',
  large: 'Large',
  seeThrough: 'See-through',
  whenItShrinks: 'When it shrinks',
  shrinkIdle: 'Shrink when not in use',
  shrinkIdleBody: 'Shrinks after a few idle seconds',
  shrinkDot: 'Shrink to a dot',
  shrinkDotBody: 'A dot instead of the bubble',
  shrinkSearch: 'Shrink in search fields',
  shrinkSearchBody: 'So it doesn’t cover search results',
  bubblePreview: 'Bubble preview',
  // Permissions
  theBubbleNeeds: 'The bubble needs',
  microphone: 'Microphone',
  microphoneBody: 'To hear you',
  overlay: 'Display over other apps',
  overlayRowBody: 'To show the bubble',
  insertion: 'Insert your words',
  insertionBody: 'Accessibility, to type into text boxes',
  notifications: 'Notifications',
  notificationsBody: 'Shows while the bubble is running',
  background: 'Background use',
  backgroundBody: 'Stops Android closing the bubble',
  insertionNoticeTitle: 'Insert your words',
  insertionNotice:
    'To put your words into Messages, Gmail and other apps, OpenWhispr uses Android Accessibility. It only reads the text box you’re dictating into: when you start, and for 45 seconds after your words go in, so a word you fix there joins your dictionary. Never password fields, and it never taps buttons or sends messages.',
  insertionNoticeSteps:
    'On the next screen, open Installed apps → OpenWhispr and turn it on.',
  permissionOn: '{{name}} is on',
  // Language
  searchLanguages: 'Search languages',
  autoDetect: 'Auto-detect',
  recommended: 'Recommended',
  languagesFooter: '{{count}} languages, A to Z. Scroll for the rest.',
  noLanguages: 'No languages match “{{query}}”',
  modelCantDo: '{{model}} can’t do {{language}}',
  modelCantDoBody: 'Switch to {{other}} to keep dictating on this phone, or use OpenWhispr Cloud.',
  modelCantDoCloud:
    'Dictation on this phone can’t do {{language}} yet. Use OpenWhispr Cloud for it.',
  keepModel: 'Keep {{model}}',
  useModel: 'Use {{model}}',
  // Processing
  cloud: 'OpenWhispr Cloud',
  cloudBody: 'Fastest. Needs an account.',
  cloudShort: 'Cloud',
  // Settings' Processing row when tasks run in different places.
  mixed: 'Mixed',
  thisPhone: 'On device',
  thisPhoneBody: 'Private and works offline. One-time download.',
  ownKey: 'Your own API key',
  ownKeyBody: 'OpenAI, Groq, Deepgram, AssemblyAI or OpenRouter',
  speech: 'Speech',
  meetingSpeakers: 'Meeting speakers',
  meetingSpeakersBody: 'Tells voices apart',
  ready: 'Ready',
  download: 'Download',
  checkPhone: 'Check this phone',
  checkPhoneBody: 'See which models run well here',
  // Models
  downloadSpeechTitle: 'Download a speech model',
  downloadSpeechBody: 'On device needs one speech model. It downloads once and works offline.',
  speechModel: 'Speech model',
  textModel: 'Text cleanup model',
  remove: 'Remove',
  removeModel: 'Remove {{model}}',
  removeTitle: 'Remove {{model}}?',
  removeInUseBody:
    'It’s the {{kind}} model you’re using. On device stops working until you download another one. You can download it again.',
  speechKind: 'speech',
  textKind: 'text',
  sizeOf: '{{done}} of {{total}}',
  aboutSeconds: 'about {{count}} s',
  aboutMinutes: 'about {{count}} min',
  settingUp: 'Setting up…',
  isReady: '{{model}} is ready',
  removedModel: '{{model}} removed',
  undo: 'Undo',
  modelsOnPhone_one: '1 model on this phone · {{size}}',
  modelsOnPhone: '{{count}} models on this phone · {{size}}',
  nothingSpeech: 'Nothing downloaded yet. Pick one to use speech on this phone.',
  nothingText: 'Nothing downloaded yet. Pick one to clean up text on this phone.',
  nothingMeeting: 'Nothing downloaded yet. It tells voices apart in recorded meetings.',
  downloadCancelled: 'Download cancelled',
  downloadProblem: 'Download problem',
  cancelDownload: 'Cancel download of {{model}}',
  downloadModel: 'Download {{model}}',
  languages25: '25 languages',
  englishOnly: 'English only',
  englishOnlyFastest: 'English only, fastest',
  fasterOlder: 'Faster on older phones',
  bestQuality: 'Best quality',
  // Processing v2
  defaultForEveryTask: 'Default for every task',
  tasks: 'Tasks',
  meetings: 'Meetings',
  changed: 'Changed',
  allOnDevice: 'Everything stays on this phone',
  offInSettings: 'Off in Settings',
  providerConnected: '{{provider}} · connected',
  yourKeyConnected: 'Your key · connected',
  addAnotherKey: 'Add another key',
  runsOn: 'Runs on',
  model: 'Model',
  prompt: 'Prompt',
  chooseModel: 'Choose a model',
  modelId: 'Model ID',
  done: 'Done',
  meetingCloudValue: 'OpenWhispr Cloud',
  meetingPhoneValue: 'On device',
  meetingsIntro:
    'Meetings need a model that can transcribe while people talk, or the phone can transcribe after the meeting ends.',
  transcribeMeetings: 'Transcribe meetings',
  meetingCloud: 'OpenWhispr Cloud',
  meetingCloudBody: 'Words appear as people talk. Needs an account.',
  meetingPhone: 'On device',
  meetingPhoneBody: 'Private, with speaker names. Takes a few minutes.',
  speakerNames: 'Speaker names',
  useOwnKey: 'Use your own key',
  provider: 'Provider',
  apiKey: 'API key',
  change: 'Change',
  pasteKey: 'Paste your key',
  getKeyAt: 'Get a key at {{site}}',
  keyWillRun: 'Your key will run',
  useForTasks_one: 'Use for 1 task',
  useForTasks: 'Use for {{count}} tasks',
  keyRefused:
    '{{provider}} didn’t accept this key. Check that it’s copied in full, or make a new one.',
  keyManagement: 'That’s an OpenRouter management key. Use a regular API key.',
  keyStatus:
    '{{provider}} couldn’t check this key (error {{status}}). Check it, or make a new one.',
  keyNoAnswer: 'Couldn’t reach {{provider}} to check this key.',
  tryAgain: 'Try again',
  dictationAndUploads: 'Dictation and uploads',
  textCleanupAndNotes: 'Text cleanup and notes',
  cantWriteText: 'Stay where they are: {{provider}} can’t write text',
  meetingKeyValue: '{{provider}} · {{model}}',
  meetingOwnKeyBody: 'Live, with an OpenAI, Deepgram or AssemblyAI key',
  cantTranscribe: 'Stay where they are: {{provider}} can’t transcribe',
  keyUsed_one: '{{provider}} now runs 1 task',
  keyUsed: '{{provider}} now runs {{count}} tasks',
  keySaveFailed: 'Couldn’t save the key. Try again.',
  keyCheckState: 'Key check: {{state}}',
  keyChecking: 'checking',
  keyAccepted: 'accepted',
  keyNotAccepted: 'not accepted',
  // Customize each task
  audioUploads: 'Audio uploads',
  noteFormatting: 'Note formatting',
  cleanup: 'Cleanup',
  cleanupPrompt: 'Cleanup prompt',
  promptIntro:
    'The instructions the AI follows when it cleans up dictation from the app, the bubble and uploaded recordings.',
  promptFooter: 'Used for every cleanup. Language, dictionary and tone are added automatically.',
  promptLong: 'Long prompts slow down cleanup.',
  savePrompt: 'Save prompt',
  promptSaved: 'Prompt saved',
  resetToDefault: 'Reset to default',
  resetPromptBody:
    'Your custom cleanup prompt will be removed and the built-in prompt used instead.',
  promptCleanupOff:
    'Text cleanup is off in Settings, under Dictation. Your prompt is saved and applies once it’s on.',
  promptSkippedOnPhone:
    'While On device is the default, cleanup is skipped until it runs on device or a key. Your prompt applies when it runs.',
  promptSkippedKey:
    'Cleanup is skipped until Text cleanup has somewhere to run. Your prompt applies once it does.',
  custom: 'Custom',
  default: 'Default',
  // Keep history
  keepDictationHistory: 'Keep dictation history',
  forever: 'Forever',
  thirtyDays: '30 days',
  sevenDays: '7 days',
  dontSave: 'Don’t save',
  historyFooter: 'Older history is deleted from this phone. Cloud backup follows the same rule.',
  deleteOlderTitle: 'Delete older dictations?',
  deleteOlderBody:
    'Dictations older than {{period}} will be deleted from this phone now. Notes are kept.',
  stopSavingTitle: 'Stop saving dictations?',
  stopSavingBody:
    'All dictation history on this phone is deleted now, and new dictations won’t be saved. This can’t be undone. Notes are kept.',
  delete: 'Delete',
  deleteAll: 'Delete all',
  olderDeleted: 'Older dictations deleted',
  historySaved: 'History kept forever',
  // Analytics
  analyticsIntro:
    'Analytics never includes what you say, write or record. It only tells us how the app is running, so we can fix errors and make it faster.',
  share: 'Share',
  usageAnalytics: 'Usage analytics',
  usageAnalyticsBody: 'Crashes, errors and speed',
  syncStats: 'Sync dictation statistics',
  syncStatsBody: 'Word counts, never transcripts',
  neverCollected: 'Never collected',
  wordsTranscripts: 'Your words and transcripts',
  audioRecordings: 'Audio recordings',
  notesDictionary: 'Notes and dictionary',
  never: 'Never',
  analyticsOn: 'Usage analytics on',
  analyticsOff: 'Usage analytics off',
  statsSignInTitle: 'Sign in to sync statistics',
  statsSignInBody:
    'Word counts sync to your account so Insights match on all your devices. Transcript text is never sent.',
  statsHistoryTitle: 'Turn on dictation history first',
  statsHistoryBody: 'Statistics come from saved dictations. Keep history is set to Don’t save.',
  keepHistoryAction: 'Keep history',
  // Check this phone
  yourResult: 'Your result',
  recording: 'Recording',
  total: 'Total',
  seconds: '{{value}} s',
};

export type SettingsKey = keyof typeof settingsEnglish;
export const SETTINGS_NAMESPACE = 'androidSettings';

i18n.addResourceBundle('en', SETTINGS_NAMESPACE, settingsEnglish, true, false);
for (const [language, strings] of Object.entries(settingsTranslations))
  i18n.addResourceBundle(language, SETTINGS_NAMESPACE, strings, true, false);

export type SettingsT = (key: SettingsKey, options?: Record<string, unknown>) => string;

export function useSettingsT(): SettingsT {
  const { t } = useTranslation(SETTINGS_NAMESPACE);
  return (key, options) => t(key, options) as string;
}

export const settingsT: SettingsT = (key, options) =>
  i18n.t(key, { ns: SETTINGS_NAMESPACE, ...options }) as string;

/**
 * Binds the last two words (three when the last is three characters or less) with no-break
 * spaces, so wrapped copy never ends on a single word, and keeps " · " on the line before.
 * Chinese and Japanese are left alone.
 */
export function noOrphan(text: string): string {
  if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)) return text;
  // A wrapped line never starts with the " · " separator.
  text = text.replaceAll(' · ', '\u00A0· ');
  const words = text.split(' ');
  if (words.length < 3) return text;
  const bound = words[words.length - 1].length <= 3 && words.length > 3 ? 3 : 2;
  return [...words.slice(0, -bound), words.slice(-bound).join(' ')].join(' ');
}
