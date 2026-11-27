import { PermissionsAndroid } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import { AndroidDictation } from '../../../modules/android-dictation/src';
import { ReasoningService } from '@/android/reasoning/ReasoningService';
import { getAccountFirstName } from '@/android/shared/lib/accountDisplay';
import { useAuthStore } from '@/android/store/useAuthStore';
import { createAndroidJob, processAndroidAudio, type AndroidJob } from '../pipeline';

// Onboarding practice is the free Cloud trial, whatever mode the phone has saved.
const PRACTICE_ROUTE: AndroidJob['route'] = {
  provider: 'cloud',
  cleanupRoute: { mode: 'openwhispr', scope: 'cleanup' },
};

export type PracticeFormat = 'email';

// The request carries no hint about the field, so the Gmail practice asks the model for the shape
// the practice shows.
const FORMAT_PROMPTS: Record<PracticeFormat, string> = {
  email:
    'Format the dictated text as a short email. Put the greeting on its own line, then a blank line, then the body starting with a capital letter, then a blank line. End with the closing word (such as Thanks or Best) on its own line followed by a comma, and the sender’s name on the line after it. When the speaker corrects themselves, keep only the corrected version. Keep the speaker’s language and wording otherwise. Return only the email, with no subject line and no introduction.',
};

// Models fill unknown names with "[Name]" or "[Your Name]"; the Gmail card must read as a real email.
function noPlaceholders(sender: string | null): string {
  return ` Never leave placeholders in square brackets such as [Name] or [Your Name]: use the names the text gives${
    sender ? `, sign it from ${sender}` : ''
  }, and leave out a name nobody gave (a greeting becomes "Hi," and the closing word stands alone).`;
}

async function formatPractice(
  text: string,
  format: PracticeFormat,
  job: AndroidJob,
  signal: AbortSignal,
): Promise<string> {
  try {
    const sender = getAccountFirstName(useAuthStore.getState().user);
    const result = await ReasoningService.processText({
      text,
      systemPrompt: FORMAT_PROMPTS[format] + noPlaceholders(sender),
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

type PracticeFailureKey = 'noSpeech' | 'practiceFailed' | 'noSpeechHold' | 'practiceFailedHold';

/**
 * The practice's own words for a failure: no speech, or try again. The raw error (a native exception,
 * an HTTP status) goes to the log, never to the card. [gesture] is how the step starts a take: the
 * menu practices only start on a hold (a tap there just nudges), so their copy says hold.
 */
export function practiceFailure(
  t: (key: PracticeFailureKey) => string,
  failure: unknown,
  gesture: 'tap' | 'hold' = 'tap',
): string {
  const message = failure instanceof Error ? failure.message : String(failure);
  const hold = gesture === 'hold';
  if (/hear|speech/i.test(message)) return t(hold ? 'noSpeechHold' : 'noSpeech');
  console.warn('[onboarding] practice failed', message);
  return t(hold ? 'practiceFailedHold' : 'practiceFailed');
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

// The native module keeps one in-app recording. "Already active" there means a recording nothing
// here owns any more: a practice screen that unmounted, or was rebuilt by a sign-in, while its start
// was still in flight (Josh's A73, 23 Nov: a recording left open for 4 minutes).
const ALREADY_ACTIVE = /already active/i;

async function discard(audio: { uri?: string } | null): Promise<void> {
  if (audio?.uri) await FileSystem.deleteAsync(audio.uri, { idempotent: true }).catch(() => {});
}

// The practice bubble records inside the app, so it works before the overlay and
// accessibility switches are on, and runs the same pipeline the real bubble uses.
export class PracticeRecorder {
  private recording = false;
  private starting: Promise<boolean> | null = null;
  private cancelRequested = false;
  private controller: AbortController | null = null;

  /**
   * Starts listening; resolves false when a cancel came in while it started. A second call while one
   * is starting or listening shares it rather than asking the native module for a second recording.
   */
  start(): Promise<boolean> {
    if (!AndroidDictation)
      return Promise.reject(new Error('Dictation is not available on this device.'));
    if (this.recording) return Promise.resolve(true);
    if (this.starting) return this.starting;
    this.controller?.abort();
    this.cancelRequested = false;
    const starting = this.open().finally(() => {
      if (this.starting === starting) this.starting = null;
    });
    this.starting = starting;
    return starting;
  }

  private async open(): Promise<boolean> {
    const dictation = AndroidDictation!;
    try {
      await dictation.startRecording(true);
    } catch (error) {
      if (!ALREADY_ACTIVE.test((error as Error).message)) throw error;
      await discard(await dictation.stopRecording(true).catch(() => null));
      await dictation.startRecording(true);
    }
    if (this.cancelRequested) {
      await discard(await dictation.stopRecording(true).catch(() => null));
      return false;
    }
    this.recording = true;
    return true;
  }

  async cancel(): Promise<void> {
    this.controller?.abort();
    this.controller = null;
    if (this.starting) {
      this.cancelRequested = true;
      await this.starting.catch(() => false);
      return;
    }
    if (!this.recording || !AndroidDictation) return;
    this.recording = false;
    await discard(await AndroidDictation.stopRecording(true).catch(() => null));
  }

  async finish(format?: PracticeFormat): Promise<string> {
    return this.run(createAndroidJob('dictate'), format);
  }

  /**
   * Practice 2: the spoken words are a request ("write Tim an email…"), run through the same
   * Assistant pipeline the bubble's menu uses, then laid out as the email the Gmail card shows.
   */
  async finishWrite(): Promise<string> {
    return this.run(createAndroidJob('write'), 'email');
  }

  /**
   * Practice 3: the spoken words are an instruction for [selection] ("make it friendlier"), run through
   * the same Edit selection pipeline the bubble's menu uses. Returns the replacement for the selection.
   */
  async finishEdit(selection: string, target: string): Promise<string> {
    return this.run(createAndroidJob('edit', target, selection));
  }

  private async run(base: AndroidJob, format?: PracticeFormat): Promise<string> {
    if (!AndroidDictation) throw new Error('Dictation is not available on this device.');
    this.recording = false;
    const audio = await AndroidDictation.stopRecording(false);
    const controller = new AbortController();
    this.controller = controller;
    try {
      const job: AndroidJob = { ...base, route: PRACTICE_ROUTE };
      const text = (await processAndroidAudio(audio, job, controller.signal, () => {})).trim();
      return format ? await formatPractice(text, format, job, controller.signal) : text;
    } finally {
      if (this.controller === controller) this.controller = null;
      await FileSystem.deleteAsync(audio.uri, { idempotent: true }).catch(() => {});
    }
  }

  get active(): boolean {
    return this.recording;
  }

  /** Listening, or on the way to it. */
  get busy(): boolean {
    return this.recording || this.starting !== null;
  }
}
