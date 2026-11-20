import {
  captureTranscriptScope,
  isTranscriptScopeCurrent,
  observeTranscriptScope,
  type TranscriptScope,
} from '@/lib/transcriptScope';
import { transcribeAndCleanup } from '@/lib/transcribeAndCleanup';
import { snapshotTranscriptionJob, type TranscriptionJobRoute } from '@/lib/inferenceRouting';
import {
  getPreferredTranscriptionLanguage,
  getPreferredTranscriptionLanguages,
} from '@/lib/transcriptionLanguage';
import { ReasoningService } from '@/services/reasoning/ReasoningService';
import { LocalTranscriptionService } from '@/services/transcription/LocalTranscriptionService';
import { useConfigStore } from '@/store/useConfigStore';
import { useTranscriptStore } from '@/store/useTranscriptStore';
import { modelReady } from './models';
import { selectedTextModel } from './LocalTextModel';
import { selectedSpeechModel } from './speechSelection';
import { speechModelSupportsLanguages } from './speechCapabilities';
import type { Recording } from '../../modules/android-dictation/src';
import type { KeyboardTone } from '@/types';
import { cleanupSavedOnDevice } from '@/lib/aiWorkflows.android';
import i18n from './strings';
import * as Crypto from 'expo-crypto';
import { insightsScope, countSpokenWords, recordInsight } from './insights';
import {
  buildSelectionEditUserPrompt,
  extractSelectionEditReplacement,
  SELECTION_EDIT_SYSTEM_PROMPT,
  SelectionEditError,
} from './selectionEdit';

export type DictationMode = 'dictate' | 'translate' | 'write' | 'edit';
export class AndroidCleanupError extends Error {
  constructor(
    message: string,
    readonly transcript: string,
  ) {
    super(message);
    this.name = 'AndroidCleanupError';
  }
}
export interface AndroidJob {
  historyScope: TranscriptScope;
  eventId: string;
  startedAt: string;
  localDate: string;
  accountScope: string;
  route: TranscriptionJobRoute;
  mode: DictationMode;
  target: string;
  selection: string;
  language?: string;
  tone?: KeyboardTone;
}
export function createAndroidJob(
  mode: DictationMode = 'dictate',
  target = 'Spanish',
  selection = '',
): AndroidJob {
  const config = useConfigStore.getState().config;
  const now = new Date();
  return {
    eventId: Crypto.randomUUID(),
    startedAt: now.toISOString(),
    localDate: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`,
    accountScope: insightsScope(),
    historyScope: captureTranscriptScope(),
    route: snapshotTranscriptionJob('dictation'),
    mode,
    target,
    selection,
    language: getPreferredTranscriptionLanguage(),
    tone:
      config?.androidStyleTones?.[config.androidStyleContext ?? 'personal'] ?? config?.keyboardTone,
  };
}
export async function ensureAndroidModels(job: AndroidJob): Promise<void> {
  const speech = selectedSpeechModel();
  if (
    job.route.provider === 'local' &&
    !speechModelSupportsLanguages(
      speech,
      job.language ? [job.language] : getPreferredTranscriptionLanguages(),
    )
  )
    throw new Error(
      i18n.t(speech === 'parakeet-v3' ? 'unsupportedLanguage' : 'moonshineEnglishOnly'),
    );
  if (job.route.provider === 'local' && !(await modelReady(speech)))
    throw new Error(i18n.t('speechDownloadNeeded'));
  const config = useConfigStore.getState().config;
  const cleanupRuns =
    config?.cleanupEnabled !== false &&
    (job.route.provider !== 'local' || cleanupSavedOnDevice(config));
  if (
    job.route.cleanupRoute?.mode === 'local' &&
    (job.mode !== 'dictate' || cleanupRuns) &&
    !(await modelReady(selectedTextModel()))
  )
    throw new Error(i18n.t('textDownloadNeeded'));
}
export async function applyHistoryRetention(): Promise<void> {
  const days = useConfigStore.getState().config?.androidHistoryDays ?? -1;
  if (days < 0) return;
  const scope = captureTranscriptScope();
  const store = useTranscriptStore.getState();
  await store.loadTranscripts();
  if (!isTranscriptScopeCurrent(scope)) return;
  const cutoff = Date.now() - days * 86400000;
  for (const item of useTranscriptStore.getState().transcripts) {
    if (!isTranscriptScopeCurrent(scope)) return;
    if (item.createdAt <= cutoff) await useTranscriptStore.getState().deleteTranscript(item.id);
  }
}
const NO_CHAT =
  'Never ask a question, explain, comment or reply to the speaker: if the request is unclear, make your best reasonable attempt.';

/**
 * System prompts for the bubble's hold-menu actions. The speaker's words are data for the task,
 * never a conversation: a question pasted into their text field replaces what they selected.
 */
export function androidActionPrompt(
  mode: Exclude<DictationMode, 'dictate'>,
  target: string,
  sender: string | null,
): string {
  if (mode === 'translate')
    return `Translate the supplied text into ${target}. ${NO_CHAT} Return only the translation.`;
  if (mode === 'write')
    return [
      'Write the message, email or text the speaker asks for, in their voice, ready to send.',
      'Keep every name, recipient, date and detail from the request; when it names the recipient, greet them by name (for "Write Tim an email…", start with "Hi Tim,").',
      'Never use placeholders in square brackets such as [Name], [Your Name], [Date] or [Company]: leave out a detail nobody gave and write around it.',
      sender
        ? `Sign it from ${sender} when the message takes a sign-off.`
        : 'When the message takes a sign-off, end with the closing word alone, without a name.',
      'Do not invent facts the request does not give, and do not add a subject line unless asked.',
      NO_CHAT,
      'Return only the message, with no introduction or notes.',
    ].join(' ');
  return SELECTION_EDIT_SYSTEM_PROMPT;
}

// A question, an unchanged copy or a malformed reply is a failed edit: the selection stays as it
// was and the bubble offers Retry, with the reason in Home.
function editReplacement(reply: string, selection: string): string {
  try {
    return extractSelectionEditReplacement(reply, selection);
  } catch (error) {
    if (!(error instanceof SelectionEditError)) throw error;
    throw new Error(i18n.t(error.reason === 'question' ? 'editQuestion' : 'editNotApplied'));
  }
}

// Loaded on use: the auth store pulls in the auth client, which dictation itself never needs.
function senderFirstName(): string | null {
  const { useAuthStore } = require('@/store/useAuthStore') as typeof import('@/store/useAuthStore');
  const { getAccountFirstName } =
    require('@/lib/accountDisplay') as typeof import('@/lib/accountDisplay');
  return getAccountFirstName(useAuthStore.getState().user);
}

// A rewritten selection is about as long as the selection (plus its JSON escaping), so a long email
// must not be cut off.
function actionMaxTokens(job: AndroidJob): number {
  if (job.mode !== 'edit') return 384;
  return Math.min(2048, Math.max(384, Math.ceil(job.selection.length / 2)));
}

export async function processAndroidAudio(
  recording: Recording,
  job: AndroidJob,
  parentSignal: AbortSignal,
  stage: (value: string) => void,
): Promise<string> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const signal = controller.signal;
  const stopObserving = observeTranscriptScope(abort);
  parentSignal.addEventListener('abort', abort, { once: true });
  const assertCurrent = () => {
    if (parentSignal.aborted || signal.aborted || !isTranscriptScopeCurrent(job.historyScope))
      throw new Error(i18n.t('cancelled'));
  };
  try {
    assertCurrent();
    if (recording.noSpeech) throw new Error(i18n.t('noSpeech'));
    await ensureAndroidModels(job);
    assertCurrent();
    const cancelSpeech = () => {
      if (job.route.provider === 'local') void LocalTranscriptionService.cancelTranscription();
    };
    signal.addEventListener('abort', cancelSpeech, { once: true });
    const output = await transcribeAndCleanup(
      {
        ...job.route,
        audioUri: recording.uri,
        jobId: job.eventId,
        clientTranscriptionId: job.eventId,
        language: job.language ?? 'auto',
        mimeType: 'audio/wav',
        requestContext: 'keyboard',
        purpose: 'dictation',
        keyboardTone: job.tone,
      },
      {
        signal,
        transcriptionOnly: job.mode !== 'dictate',
        shouldCancel: () => signal.aborted,
        onStage: (value) => stage(value === 'cleaning' ? 'cleaning' : 'processing'),
      },
    ).finally(() => signal.removeEventListener('abort', cancelSpeech));
    assertCurrent();
    if (output.transcription.cleanupWarning)
      throw new AndroidCleanupError(output.transcription.cleanupWarning, output.originalText);
    let text = output.text;
    if (job.mode !== 'dictate') {
      if (job.route.cleanupUnavailable) throw new Error(job.route.cleanupUnavailable);
      stage('cleaning');
      const result = await ReasoningService.processText({
        text:
          job.mode === 'edit'
            ? buildSelectionEditUserPrompt(output.originalText, job.selection)
            : output.originalText,
        systemPrompt: androidActionPrompt(job.mode, job.target, senderFirstName()),
        inferenceScope: 'cleanup',
        inferenceRoute: job.route.cleanupRoute,
        routing:
          job.route.cleanupRoute?.mode === 'providers'
            ? { sendToChosenProvider: true }
            : { isPrivateNote: job.route.provider === 'local' },
        signal,
        maxTokens: actionMaxTokens(job),
      });
      text = job.mode === 'edit' ? editReplacement(result.text, job.selection) : result.text;
    }
    assertCurrent();
    if (!text.trim()) throw new Error(i18n.t('noSpeech'));
    // Count spoken input, never the expanded snippet or generated response.
    if (job.mode === 'dictate') {
      try {
        recordInsight(job.accountScope, {
          event_id: job.eventId,
          occurred_at: job.startedAt,
          local_date: job.localDate,
          word_count: countSpokenWords(output.originalText),
          spoken_duration_ms: recording.durationMs > 0 ? Math.round(recording.durationMs) : null,
          mode: job.route.provider === 'cloud' ? 'openwhispr_cloud' : job.route.provider,
          provider: job.route.provider,
          model: null,
          counter_version: 2,
        });
      } catch {
        /* Statistics must never prevent insertion. */
      }
    }
    const days = useConfigStore.getState().config?.androidHistoryDays ?? -1;
    if (days !== 0) {
      try {
        await useTranscriptStore.getState().addTranscript({
          text,
          originalText: output.originalText,
          duration: recording.durationMs / 1000,
          requestContext: 'keyboard',
          ...job.route,
        });
        await applyHistoryRetention();
      } catch (error) {
        console.warn('[dictation] history could not be saved', error);
      }
    }
    assertCurrent();
    return text;
  } finally {
    stopObserving();
    parentSignal.removeEventListener('abort', abort);
  }
}
