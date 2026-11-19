import { UsageLimitError } from '@/lib/usageLimitError';
import { isAccountRequiredError } from '@/lib/accountRequiredError';
import { toFriendlyTranscriptionErrorMessage } from '@/lib/transcriptionErrors';
import type { BubbleMessage } from '../../modules/android-dictation/src';
import type { DictationMode } from './pipeline';

/** What the bubble shows after a failed take, and whether its recording is worth sending again. */
export interface BubbleFailure {
  message: BubbleMessage;
  /** Kept recordings are sent again by Retry; the rest are deleted. */
  keep: boolean;
}

/** The pipeline's own error messages (i18n.t in the bubble's runtime). */
export interface PipelineMessages {
  noSpeech: string;
  speechDownloadNeeded: string;
  textDownloadNeeded: string;
}

/**
 * Turns a failed take into the status tab's message. Each kind of failure has its own words and its
 * own action, instead of one "Didn't catch that" for everything:
 * - silence → "Didn't hear you · Try again" (listens again; nothing to keep)
 * - offline or timed out → "No connection · Retry" (the recording is kept)
 * - weekly words used up → "Out of words · See plans"
 * - signed out → "Signed out · Sign in"
 * - a local model not downloaded → "Model not downloaded · Download"
 * - anything else → "Couldn't finish · Try again" (the recording is kept)
 */
export function bubbleFailure(
  error: unknown,
  noSpeech: boolean,
  messages: PipelineMessages,
): BubbleFailure {
  const text = (error as Error | undefined)?.message ?? '';
  if (noSpeech || text === messages.noSpeech) return { message: 'no-speech', keep: false };
  if (error instanceof UsageLimitError || (error as { status?: number })?.status === 429)
    return { message: 'out-of-words', keep: false };
  if (isAccountRequiredError(error)) return { message: 'sign-in', keep: false };
  if (text === messages.speechDownloadNeeded || text === messages.textDownloadNeeded)
    return { message: 'model-needed', keep: false };
  if (/connection/i.test(toFriendlyTranscriptionErrorMessage(error)))
    return { message: 'offline', keep: true };
  return { message: 'failed', keep: true };
}

/** Edit selection needs text to edit; the other menu modes work at the caret too. */
export function bubbleMode(value: string | undefined, selection: string): DictationMode {
  if (value === 'write' || value === 'translate') return value;
  if (value === 'edit') return selection ? 'edit' : 'write';
  return 'dictate';
}
