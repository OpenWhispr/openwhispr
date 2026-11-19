import { useTranslation } from 'react-i18next';
import i18n from '../strings';
import { SETTINGS_NAMESPACE, type SettingsKey } from '../settings/strings';
import { fableTranslations } from './translations';

/**
 * Processing · Fable's take: its own copy, added to the androidSettings namespace. Anything
 * Settings already says (OpenWhispr Cloud, On device, Undo…) is read from there.
 */
export const fableEnglish = {
  whereProcessed: 'Where your voice is processed',
  cloudSignedIn: 'Fastest. You’re signed in.',
  cloudSignedOut: 'Fastest. Sign in to use it.',
  deviceBody: 'Private. Works offline.',
  keyPlaceBody: 'Billed by your provider.',
  noTasksHere: 'No tasks here.',
  noTasksYet: 'No tasks here yet.',
  taskCount_one: '{{count}} task',
  taskCount: '{{count}} tasks',
  useForEverything: 'Use for everything',
  noKeysYet: 'No keys yet.',
  addAKey: 'Add a key',
  keyEnding: 'Key ending {{tail}}',
  keyEndingIdle: 'Key ending {{tail}} · not running anything',
  noKeyNeeded: 'No key needed',
  noKeyNeededIdle: 'No key needed · not running anything',
  tapTaskHint: 'Tap a task to run it somewhere else.',
  meetingsLive: 'Meetings · live',
  meetingsAfter: 'Meetings · after',
  everythingCloud: 'Everything runs on OpenWhispr Cloud',
  everythingDevice: 'Everything runs on this phone',
  everythingDeviceSoon: 'Each task moves to this phone as its model lands',
  downloadingLine: 'Downloading {{model}} · {{done}} of {{total}}',
  cancelDownloads: 'Cancel the downloads',
  fastest: 'Fastest',
  wordsAsPeopleTalk: 'Words appear as people talk',
  speakerNamesDownload: 'Speaker names · {{size}} download',
  speakerNamesLine: 'Speaker names',
  modelDownloadLine: '{{model}} · {{size}} download',
  live: 'Live',
  after: 'After',
  sourceKey: '{{provider}} key',
  cantRunMeetings: '{{provider}} can’t run meetings',
  modelOnPhone: 'Model on this phone',
  sharedModel: '{{task}} uses this model too.',
  taskModel: '{{task}} model',
  onlyThisTask: 'Only {{task}} changes. Other tasks keep their own model.',
  cleanupIsOff: 'Text cleanup is off. Turn it on in Settings → Dictation.',
  chooseProvider: 'Choose a provider',
  groupSpeechText: 'Speech and text',
  groupSpeech: 'Speech only',
  groupText: 'Text only',
  groupOwn: 'Your own',
  capOpenai: 'All 5 tasks',
  capGroq: 'Everything but meetings',
  capSpeech: 'Dictation, uploads, meetings',
  capText: 'Text cleanup and notes',
  capCustom: 'Any address that speaks the OpenAI API',
  lineOpenai: 'Runs all 5 tasks. Meetings run live.',
  lineGroq: 'Runs dictation, uploads, text cleanup and notes. It can’t run meetings.',
  lineSpeech: 'Runs dictation, uploads and meetings. Meetings run live.',
  lineText: 'Runs text cleanup and note formatting.',
  pasteProviderKey: 'Paste your {{provider}} key',
  useForAll: 'Use for all {{count}} tasks',
  saveKeyOnly: 'Save key only',
  customServer: 'Custom server',
  serverAddress: 'Server address',
  serverExample: 'For example https://llm.acme.internal/v1',
  serverKey: 'API key (if your server needs one)',
  pasteTheKey: 'Paste the key',
  checkServer: 'Check server',
  foundBoth: 'Found speech and text models. It can’t run meetings live.',
  foundSpeech: 'Found speech models. It can’t run meetings live.',
  foundText: 'Found text models. It runs text cleanup and notes.',
  foundNone: 'The server answered, but it lists no models.',
  serverUnreachable:
    'Couldn’t reach this address. Check it, and that this phone is on the same network.',
  serverInvalid: 'Use an https address, or http on your local network.',
  serverRefusedKey: 'The server refused this key.',
  serverNeedsKey: 'This server needs a key.',
  saveServerOnly: 'Save server only',
  keyAddedAll: '{{provider}} key added. It runs all 5 tasks.',
  keyAddedRuns_one: '{{provider}} key added. It runs 1 task.',
  keyAddedRuns: '{{provider}} key added. It runs {{count}} tasks.',
  keyAdded: '{{provider}} key added',
  serverAddedRuns_one: 'Custom server added. It runs 1 task.',
  serverAddedRuns: 'Custom server added. It runs {{count}} tasks.',
  serverAdded: 'Custom server added',
  keyRemoved: '{{provider}} key removed',
  serverRemoved: 'Custom server removed',
  keyChanged: '{{provider}} key changed',
  runsLabel: 'Runs',
  moveHint: 'Tap a task on Processing to move it.',
  runsNothing: 'Not running anything. Tap a task on Processing to move it here.',
  removeKey: 'Remove key',
  removeServer: 'Remove server',
  runEverythingTitle: 'Run everything on this phone?',
  runEverythingBody:
    'On device needs these models, about {{size}}. Your tasks keep running where they are until each one is ready.',
  downloadSize: 'Download {{size}}',
  checkPhoneFirst: 'Check this phone first',
  speechLine: 'Speech · {{size}}',
  speechLineLanguages: 'Speech · {{languages}} · {{size}}',
  textLine: 'Text · {{size}}',
  speakersLine: 'Speaker names · {{size}}',
  // Check this phone (8.9–8.12, copied from the v1 test build)
  memoryNow: 'Memory available now',
  freeSpaceModels: 'Free space for models',
  androidVersion: 'Android {{version}}',
  coresValue: '{{count}} cores',
  heat: 'Heat',
  heatNormal: 'Normal',
  heatHot: 'Hot',
  heatUnknown: 'Unknown',
  usesSelected: 'Uses your selected models and language',
  recordingHint:
    'Choose a recording of 30 seconds or less. It runs on this phone and isn’t saved to history.',
  stepOf: 'Step {{step}} of {{count}}',
  fasterThanSpoke: 'Faster than you spoke. Read the words below before keeping these models.',
  slowerThanSpoke:
    'Slower than you spoke. Read the words below, and try a smaller model if it felt slow.',
  recognizedWords: 'Recognized words',
  afterCleanup: 'After cleanup',
  testAnother: 'Try another recording',
};

export type FableKey = keyof typeof fableEnglish;
type ExtraPluralKey =
  `${'keyAddedRuns' | 'serverAddedRuns' | 'taskCount'}_${'zero' | 'two' | 'few' | 'many' | 'other'}`;
export type FableTranslations = Record<string, Partial<Record<FableKey | ExtraPluralKey, string>>>;

// Deep-merged into Settings' namespace without overwriting any key Settings already has.
i18n.addResourceBundle('en', SETTINGS_NAMESPACE, fableEnglish, true, false);
for (const [language, strings] of Object.entries(fableTranslations))
  i18n.addResourceBundle(language, SETTINGS_NAMESPACE, strings, true, false);

export type FableT = (key: FableKey | SettingsKey, options?: Record<string, unknown>) => string;

export function useFableT(): FableT {
  const { t } = useTranslation(SETTINGS_NAMESPACE);
  return (key, options) => t(key, options) as string;
}

export const fableT: FableT = (key, options) =>
  i18n.t(key, { ns: SETTINGS_NAMESPACE, ...options }) as string;
