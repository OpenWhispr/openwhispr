import { PermissionsAndroid } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import { AndroidDictation } from '../../../modules/android-dictation/src';
import { ReasoningService } from '@/services/reasoning/ReasoningService';
import { createAndroidJob, processAndroidAudio, type AndroidJob } from '../pipeline';

// Onboarding practice is the free Cloud trial, whatever mode the phone has saved.
const PRACTICE_ROUTE: AndroidJob['route'] = {
  provider: 'cloud',
  cleanupRoute: { mode: 'openwhispr', scope: 'cleanup' },
};

export type PracticeFormat = 'email' | 'list';

// The cleanup request carries no hint about the field, so the email and list practices
// ask the cleanup model for the shape the practice shows.
const FORMAT_PROMPTS: Record<PracticeFormat, string> = {
  email:
    'Format the dictated text as a short email. Put the greeting on its own line, then a blank line, then the body starting with a capital letter, then a blank line. End with the closing word (such as Thanks or Best) on its own line followed by a comma, and the sender’s name on the line after it. When the speaker corrects themselves, keep only the corrected version. Keep the speaker’s language and wording otherwise. Return only the email, with no subject line and no introduction.',
  list: 'Format the dictated text as a list. If it starts with a heading such as "Things to do today", keep it as the first line ending with a colon. Put each item on its own line starting with "- ", capitalised, without trailing punctuation. Keep the speaker’s language and words. Return only the list, with no introduction.',
};

async function formatPractice(
  text: string,
  format: PracticeFormat,
  job: AndroidJob,
  signal: AbortSignal,
): Promise<string> {
  try {
    const result = await ReasoningService.processText({
      text,
      systemPrompt: FORMAT_PROMPTS[format],
      inferenceScope: 'cleanup',
      inferenceRoute: job.route.cleanupRoute,
      signal,
      maxTokens: 384,
    });
    return result.text.trim() || text;
  } catch (error) {
    // The cleaned dictation is still a good result; formatting is the bonus.
    console.warn(
      '[onboarding] practice formatting failed',
      job.route.provider,
      (error as Error).message,
    );
    if (signal.aborted) throw new Error('Cancelled.');
    return text;
  }
}

export type MicAccess = 'granted' | 'denied' | 'blocked';

// Android's own dialog ("While using the app / Only this time / Don't allow").
export async function requestMicrophone(): Promise<MicAccess> {
  const permission = PermissionsAndroid.PERMISSIONS.RECORD_AUDIO;
  if (await PermissionsAndroid.check(permission)) return 'granted';
  const result = await PermissionsAndroid.request(permission);
  if (result === PermissionsAndroid.RESULTS.GRANTED) return 'granted';
  return result === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN ? 'blocked' : 'denied';
}

// The practice bubble records inside the app, so it works before the overlay and
// accessibility switches are on, and runs the same pipeline the real bubble uses.
export class PracticeRecorder {
  private recording = false;
  private controller: AbortController | null = null;

  async start(): Promise<void> {
    if (!AndroidDictation) throw new Error('Dictation is not available on this device.');
    this.controller?.abort();
    await AndroidDictation.startRecording();
    this.recording = true;
  }

  async cancel(): Promise<void> {
    this.controller?.abort();
    this.controller = null;
    if (!this.recording || !AndroidDictation) return;
    this.recording = false;
    const audio = await AndroidDictation.stopRecording(true).catch(() => null);
    if (audio?.uri) await FileSystem.deleteAsync(audio.uri, { idempotent: true }).catch(() => {});
  }

  async finish(format?: PracticeFormat): Promise<string> {
    if (!AndroidDictation) throw new Error('Dictation is not available on this device.');
    this.recording = false;
    const audio = await AndroidDictation.stopRecording(false);
    const controller = new AbortController();
    this.controller = controller;
    try {
      const job: AndroidJob = { ...createAndroidJob('dictate'), route: PRACTICE_ROUTE };
      const text = await processAndroidAudio(audio, job, controller.signal, () => {});
      return format ? await formatPractice(text, format, job, controller.signal) : text;
    } finally {
      if (this.controller === controller) this.controller = null;
      await FileSystem.deleteAsync(audio.uri, { idempotent: true }).catch(() => {});
    }
  }

  get active(): boolean {
    return this.recording;
  }
}
