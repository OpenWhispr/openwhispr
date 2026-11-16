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
  writingUpRecording: 'Writing up your recording',
  usuallyFewSeconds: 'Usually a few seconds',
  writingItUpMinute: 'Writing it up… about a minute',
  yourRecording: 'Your recording',
  cancel: 'Cancel',
  tips: 'Tips',
  tip1Title: 'Start dictating',
  tip1Body: 'Tap a text box, tap the bubble, talk.',
  tip2Title: 'Change the bubble size',
  tip2Body: 'Account → Preferences → Bubble size.',
  tip3Title: 'Hide the bubble',
  tip3Body: 'Drag it onto “Hide for 1 hour”.',
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
