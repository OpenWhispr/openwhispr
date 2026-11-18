import { useTranslation } from 'react-i18next';
import i18n from '../strings';
import { SETTINGS_NAMESPACE, type SettingsKey } from '../settings/strings';
import { v1Translations } from './translations';

// Processing v1's own copy. Anything Settings already says is read from its namespace.
export const v1English = {
  whereProcessed: 'Where your voice is processed',
  keyBody: 'OpenAI, Groq, Deepgram and more, or your server',
  billedByProvider: 'Billed by your provider',
  advanced: 'Advanced',
  customizeTasks: 'Customize each task',
  customizeTasksBody: 'Dictation, uploads, cleanup, notes and meetings',
  onDeviceModels: 'On-device models',
  signInTitle: 'Sign in to use OpenWhispr Cloud',
  signInBody: 'Cloud processing needs an account. On device works without one.',
  yourKey: 'Your key',
  yourServer: 'Your server',
  checkConnection: 'Check connection',
  checking: 'Checking…',
  works: 'Works',
  failed: 'Failed',
  couldntCheck: 'Couldn’t check',
  addKey: 'Add key',
  connectionWorks: 'Connection works. Save to use it.',
  save: 'Save',
  savedFor: 'Saved. Every task set to {{provider}} uses this key.',
  savedDefault: 'Saved. Tasks {{provider}} can run now use it.',
  discardTitle: 'Discard unsaved changes?',
  discardBody: 'Your selection and any key you entered have not been saved.',
  discard: 'Discard',
  customServer: 'Custom server',
  customServerBody: 'Any OpenAI-compatible URL',
  speechModelFooter: 'Used for dictation and uploads. Text tasks start on {{model}}.',
  textModelFooter: 'Used for text cleanup and note formatting.',
  staysCantText:
    '{{provider}} can’t write text, so text cleanup and note formatting stay where they are.',
  staysCantSpeech:
    '{{provider}} can’t transcribe, so dictation, audio uploads and meetings stay where they are.',
  staysCantMeetings: 'Meetings stay where they are: {{provider}} can’t transcribe live.',
  apiKeyFor: '{{provider}} API key',
  keyHint: 'Stays on this phone. Every task set to {{provider}} uses the same key.',
  getKeyFrom: 'Get a key from {{provider}}',
  removeKey: 'Remove key',
  removeKeyTitle: 'Remove your {{provider}} key?',
  removeKeyBody: 'Every task set to {{provider}} stops until you add a key again.',
  keyRemoved: '{{provider}} key removed',
  server: 'Server',
  serverPlaceholder: 'https://your-server.example/v1',
  serverHint: 'On this phone, localhost is this phone. Use your server’s network address.',
  speechModelId: 'Speech model ID',
  textModelId: 'Text model ID',
  modelIdPlaceholder: 'model-name',
  modelIdBlank: 'Leave a model blank to keep those tasks where they are.',
  optional: 'Optional',
  findModels: 'Find models on this server',
  serverModels: 'Models on this server',
  noServerModels: 'This server didn’t list any models. Type the model ID instead.',
  typeModelId: 'Or type a model ID',
  use: 'Use',
  keyValue: '{{provider}} key',
  eachTask: 'Each task',
  yourApiKeys: 'Your API keys',
  usedBy: 'Used by {{tasks}}',
  notUsedYet: 'Saved, not used by a task',
  add: 'Add',
  saved: 'Saved',
  listAnd: '{{first}} and {{last}}',
  runThisTaskOn: 'Run this task on',
  cloudTaskBody: 'Fast and accurate on any phone',
  deviceDictationBody: 'Private and works offline',
  deviceUploadBody: 'Audio never leaves this phone',
  deviceTextBody: 'Text never leaves this phone',
  keyTextBody: 'Sends text only, never audio',
  sharedSpeechModel:
    'The phone keeps one speech model, so changing it here changes it for every task on device.',
  sharedTextModel:
    'The phone keeps one text model, so changing it here changes it for every task on device.',
  connection: 'Connection',
  cantTranscribeShort: 'Can’t transcribe',
  cantWriteShort: 'Can’t write text',
  cantLiveShort: 'Can’t transcribe live',
  noTextModelTitle: 'Download a text model first',
  noTextModelBody:
    '{{task}} on device needs {{small}} ({{smallSize}}) or {{large}} ({{largeSize}}).',
  settingsGroup: 'Settings',
  autoTitles: 'Auto-generate note titles',
  autoTitlesBody: 'Titles notes automatically',
  cleanupPromptBody: 'How your words are tidied',
  cleanupOffNote: 'Text cleanup is off. Turn it on in Settings, under Dictation.',
  live: 'Live',
  liveBody: 'Words appear as people talk',
  afterMeeting: 'After the meeting',
  meetingDeviceBody: 'Private, with speaker names. Takes a few minutes.',
  meetingKeyBody: 'Live on your {{provider}} key',
  meetingsCantNote:
    'Groq, OpenRouter and custom servers can’t run meetings: they don’t transcribe live.',
  downloaded: 'Downloaded',
  available: 'Available',
  frees: 'Frees {{size}}',
  inUse: 'In use',
  speakerDetection: 'Speaker detection',
  speakerFooter: 'Runs on this phone. Only needed for recorded meetings.',
  removeModelTitle: 'Remove {{model}}?',
  removeModelBody: 'It frees {{size}}. You can download it again.',
  removeInUse:
    'It’s the {{kind}} model you’re using. On device stops working until you download another one. You can download it again.',
};

export type V1Key = keyof typeof v1English;
export const V1_NAMESPACE = 'androidProcessingV1';

i18n.addResourceBundle('en', V1_NAMESPACE, v1English, true, false);
for (const [language, strings] of Object.entries(v1Translations))
  i18n.addResourceBundle(language, V1_NAMESPACE, strings, true, false);

export type V1T = (key: V1Key | SettingsKey, options?: Record<string, unknown>) => string;

/** v1's copy first, then Settings' (Cancel, Download, On device…). */
export function useV1T(): V1T {
  const { t } = useTranslation([V1_NAMESPACE, SETTINGS_NAMESPACE]);
  return (key, options) => t(key, { ns: [V1_NAMESPACE, SETTINGS_NAMESPACE], ...options }) as string;
}

export const v1T: V1T = (key, options) =>
  i18n.t(key, { ns: [V1_NAMESPACE, SETTINGS_NAMESPACE], ...options }) as string;
