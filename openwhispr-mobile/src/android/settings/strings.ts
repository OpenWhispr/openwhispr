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
  permissions: 'Permissions',
  allOn: 'All on',
  toTurnOn: '{{count}} to turn on',
  dictation: 'Dictation',
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
    'To put your words into Messages, Gmail and other apps, OpenWhispr uses Android Accessibility. It only reads the text box you’re dictating into, never password fields, and never taps buttons or sends messages.',
  insertionNoticeSteps:
    'On the next screen, open Installed apps → OpenWhispr text insertion and turn it on.',
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
  whereProcessed: 'Where your voice is processed',
  cloud: 'OpenWhispr Cloud',
  cloudBody: 'Fastest. Needs an account.',
  cloudShort: 'Cloud',
  thisPhone: 'On this phone',
  thisPhoneShort: 'This phone',
  thisPhoneBody: 'Private and works offline. One-time download.',
  ownKey: 'Your own API key',
  ownKeyBody: 'OpenAI, Groq or your server',
  onDeviceModels: 'On-device models',
  speech: 'Speech',
  meetingSpeakers: 'Meeting speakers',
  meetingSpeakersBody: 'Tells voices apart',
  ready: 'Ready',
  download: 'Download',
  advanced: 'Advanced',
  checkPhone: 'Check this phone',
  checkPhoneBody: 'See which models run well here',
  customize: 'Customize each task',
  customizeBody: 'Dictation, uploads, cleanup and notes',
  // Models
  downloadSpeechTitle: 'Download a speech model',
  downloadSpeechBody: 'On this phone needs one speech model. It downloads once and works offline.',
  downloaded: 'Downloaded',
  available: 'Available',
  speechModel: 'Speech model',
  textModel: 'Text cleanup model',
  inUse: 'In use',
  remove: 'Remove',
  removeModel: 'Remove {{model}}',
  frees: 'Frees {{size}}',
  removeTitle: 'Remove {{model}}?',
  removeBody: 'Remove it from this phone? You can download it again.',
  removeInUseBody:
    'It’s the {{kind}} model you’re using. On this phone stops working until you download another one. You can download it again.',
  speechKind: 'speech',
  textKind: 'text',
  sizeOf: '{{done}} of {{total}}',
  aboutSeconds: 'about {{count}} s',
  aboutMinutes: 'about {{count}} min',
  settingUp: 'Setting up…',
  isReady: '{{model}} is ready',
  downloadCancelled: 'Download cancelled',
  downloadProblem: 'Download problem',
  cancelDownload: 'Cancel download of {{model}}',
  downloadModel: 'Download {{model}}',
  languages25: '25 languages',
  englishOnly: 'English only',
  englishOnlyFastest: 'English only, fastest',
  fasterOlder: 'Faster on older phones',
  bestQuality: 'Best quality',
  meetingRuns: 'Runs on this phone. Only needed for recorded meetings.',
  speakerDetection: 'Speaker detection',
  // Customize each task
  eachTask: 'Each task',
  audioUploads: 'Audio uploads',
  noteFormatting: 'Note formatting',
  cleanup: 'Cleanup',
  cleanupPrompt: 'Cleanup prompt',
  cleanupPromptBody: 'How your words are tidied',
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
