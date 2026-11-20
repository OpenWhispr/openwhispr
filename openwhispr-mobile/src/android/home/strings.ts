import i18n from '../strings';
import { useTranslation } from 'react-i18next';
import { homeTranslations } from './translations';

// Home copy lives here rather than in the shared locale files, which the iOS app loads.
export const homeEnglish = {
  account: 'Account',
  bubble: 'Bubble',
  bubbleOn: 'Bubble is on',
  bubbleOnBody: 'It pops up whenever you type.',
  bubbleOff: 'Bubble is off',
  bubbleOffBody: 'Turn it on to dictate in any app.',
  needsOnePermission: 'Needs one more permission.',
  needsPermissions: 'Needs {{count}} more permissions.',
  turnOnOverlay: 'Allow display over other apps',
  turnOnAccessibility: 'Turn on Accessibility',
  turnOnMicrophone: 'Allow the microphone',
  dictate: 'Dictate',
  uploadAudio: 'Upload audio',
  writingItUp: 'Writing it up…',
  writingItUpMinute: 'Writing it up… about a minute',
  uploadingPercent: 'Uploading {{percent}}%',
  copiedAddedToHistory: 'Copied · added to History',
  cancelUpload: 'Cancel upload',
  announceWritingItUp: 'Writing it up',
  announceUploading: 'Uploading {{percent}} percent',
  cancel: 'Cancel',
  tips: 'Tips',
  tip1Title: 'Start dictating',
  tip1Body: 'Tap a text box, tap the bubble, talk.',
  tip2Title: 'Change the bubble size',
  tip2Body: 'Settings → Size & look.',
  tip3Title: 'Hide the bubble',
  tip3Body: 'Drag it onto “Hide for 15 minutes”.',
  yourStats: 'Your stats',
  wordsSpoken: 'words spoken',
  wordsPerMin: 'words / min',
  streak: 'streak',
  oneDay: '1 day',
  days: '{{count}} days',
  history: 'History',
  copied: 'Copied to clipboard',
  addedToHistory: 'Added to History',
  copy: 'Copy',
  retry: 'Retry',
  notSent: 'not sent',
  justNow: 'Just now',
  minutesAgo: '{{count}} min ago',
  hoursAgo: '{{count}} h ago',
  yesterday: 'Yesterday',
  daysAgo: '{{count}} days ago',
  listening: 'Listening',
  done: 'Done',
  discard: 'Discard recording',
  microphoneNeeded: 'Allow the microphone to try dictation.',
  close: 'Close',
  olderRecordings: 'Older recordings',
  savedBeforeAccountsCount: '{{count}} saved before accounts',
  savedBeforeAccounts: 'Saved before accounts',
  savedBeforeAccountsBody:
    'These were saved on this phone before you signed in, so they belong to no account. You can read and copy them; nothing new is added here.',
  audioOnly: 'Audio only — no text was saved',
  nothingFromBefore: 'Nothing from before',
  nothingFromBeforeBody: 'This phone has no recordings from before accounts.',
  hide: 'Hide',
  gotIt: 'Got it',
  seeAllHistory: 'See all history',
  searchHistory: 'Search your dictations',
  clearSearch: 'Clear search',
  today: 'Today',
  thisWeek: 'This week',
  noMatches: 'Nothing matches “{{query}}”.',
  savedInOpenWhispr: 'Saved in OpenWhispr',
  bubbleCouldntType: 'The bubble couldn’t type this one.',
  // TalkBack: where a History row's text came from, read before it.
  fromDictation: 'Dictated',
  fromFile: 'From an audio file',
  // TalkBack: a main tab's place in the bar, read after its name.
  tabPosition: '{{index}} of {{count}}',
  // The shared locale files leave "Notes" untranslated.
  tabNotes: 'Notes',
};

export type HomeKey = keyof typeof homeEnglish;
export const HOME_NAMESPACE = 'androidHome';

i18n.addResourceBundle('en', HOME_NAMESPACE, homeEnglish, true, false);
for (const [language, strings] of Object.entries(homeTranslations))
  i18n.addResourceBundle(language, HOME_NAMESPACE, strings, true, false);

export function useHomeT() {
  const { t } = useTranslation(HOME_NAMESPACE);
  return (key: HomeKey, options?: Record<string, unknown>) => t(key, options) as string;
}
