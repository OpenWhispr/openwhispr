import i18n from '../strings';
import { useTranslation } from 'react-i18next';
import { styleTranslations } from './translations';

// Tone & Style copy lives here rather than in the shared locale files, which the iOS app loads.
// "Tone & Style" is the feature's one name on Android; the tab is "Style". Android has no chats,
// so nothing here mentions them.
export const styleEnglish = {
  tabTitle: 'Style',
  subtitleOn: 'How cleanup and the assistant write',
  subtitleOff: 'Off · your own tone everywhere',
  switchLabel: 'Tone & Style',
  saved: 'Tone & Style saved',
  saveFailed: 'Couldn’t save Tone & Style',
  kindPersonal: 'Personal',
  kindWork: 'Work',
  kindEmail: 'Email',
  kindOther: 'Other',
  rowPersonal: 'Personal messages',
  rowWork: 'Work messages',
  rowEmail: 'Emails',
  rowOther: 'Everything else',
  toneFormal: 'Formal',
  toneCasual: 'Casual',
  toneVeryCasual: 'Very casual',
  toneExcited: 'Excited!',
  describeFormal: 'Capitals and full punctuation',
  describeCasual: 'Capitals, lighter punctuation',
  describeVeryCasual: 'lowercase, barely any punctuation',
  describeExcited: 'Capitals and more exclamation points',
  // TalkBack: what the example card shows.
  exampleLabel: 'Example in {{kind}}: {{text}}',
  toneSlider: 'Tone for {{kind}}',
  introTitle: 'Sound like you\nin every app',
  introBody:
    'Pick a tone for texts, work chat, email and everything else. When you dictate, OpenWhispr writes in it.',
  letsPersonalize: 'Let’s personalize',
  notNow: 'Not now',
  close: 'Close',
  stepOf: '{{index}} of {{count}}',
  askPersonal: 'How do you text friends?',
  askWork: 'How do you message at work?',
  askEmail: 'How do you write emails?',
  askOther: 'And everywhere else?',
  appsPersonal: 'WhatsApp, Messages, Telegram',
  appsWork: 'Slack, Teams, Google Chat',
  appsEmail: 'Gmail, Outlook, Proton Mail',
  appsOther: 'Notion, ChatGPT and the rest',
  soundsLikeMe: 'Sounds like me',
  swipeToCompare: 'Swipe to compare tones',
  doneTitle: 'You’re set',
  doneBody: 'Change any of these later in the Style tab.',
  done: 'Done',
  nudgeTitle: 'Teach OpenWhispr how you write',
  nudgeBody: 'Set your preferred style for work, friends, and everything in between.',
  startNow: 'Start Now',
};

export type StyleKey = keyof typeof styleEnglish;
export const STYLE_NAMESPACE = 'androidStyle';

i18n.addResourceBundle('en', STYLE_NAMESPACE, styleEnglish, true, false);
for (const [language, strings] of Object.entries(styleTranslations))
  i18n.addResourceBundle(language, STYLE_NAMESPACE, strings, true, false);

export function useStyleT() {
  const { t } = useTranslation(STYLE_NAMESPACE);
  return (key: StyleKey, options?: Record<string, unknown>) => t(key, options) as string;
}
