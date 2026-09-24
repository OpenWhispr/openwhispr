import { useEffect, useRef } from 'react';
import { AppState, Linking } from 'react-native';
import * as Application from 'expo-application';
import * as Clipboard from 'expo-clipboard';
import { useHandoffStore } from '@/store/useHandoffStore';
import { useKeyboardRecoveryStore } from '@/store/useKeyboardRecoveryStore';
import { useProcessingModeStore } from '@/store/useProcessingModeStore';
import { useTranscriptStore } from '@/store/useTranscriptStore';
import {
  TranscriptionService,
  isLocalModelMissingError,
} from '@/services/transcription/TranscriptionService';
import { cleanupTranscript } from '@/lib/cleanupTranscript';
import { transcribeAndCleanup } from '@/lib/transcribeAndCleanup';
import { snapshotKeyboardTone, readKeyboardToneSnapshot } from '@/lib/keyboardToneSync';
import {
  snapshotKeyboardAgentRequest,
  readKeyboardAgentJob,
  clearKeyboardAgentJob,
  consumeKeyboardAgentAction,
  type KeyboardAgentJob,
} from '@/lib/keyboardAgentSync';
import { generateForJob, handleAgentAction } from '@/services/agent/AgentComposerService';
import { expandSnippets } from '@/lib/snippets';
import { useSnippetsStore } from '@/store/useSnippetsStore';
import { analyzeSpeechActivity, serializeSpeechActivityMetrics } from '@/lib/speechActivity';
import { getPreferredTranscriptionLanguage } from '@/lib/transcriptionLanguage';
import { toFriendlyTranscriptionErrorMessage } from '@/lib/transcriptionErrors';
import { deleteManagedTranscriptAudio, retainTranscriptAudio } from '@/lib/transcriptAudio';
import {
  AppGroupStorage,
  APP_GROUP_KEYS,
  addRecordingStoppedListener,
  addRecordingErrorListener,
  addBackgroundRecordingStartedListener,
  addKeyboardStatusChangedListener,
  addAgentActionListener,
} from '../../modules/app-group-storage/src';
import { LiveActivity } from '../../modules/live-activity/src';
import { isNoSpeechError } from '@/lib/permissions';

const NO_SPEECH_DISPLAY_MS = 2200;

const KEYBOARD_DICTATION_ROUTE = 'keyboard-dictation';
// Opened by the keyboard's "Turn on Full Access" pill. Navigation is expo-router's
// (app/keyboard-full-access.tsx); this handler only stamps the recovery store so a
// concurrent warm resume can't bounce the screen, and must never start a job.
const KEYBOARD_FULL_ACCESS_ROUTE = 'keyboard-full-access';
const HANDOFF_THROTTLE_MS = 45_000;
// How long an Activate tap recorded by the keyboard stays actionable. Covers a
// cold launch (a few seconds) without resurrecting genuinely stale taps.
const HANDOFF_INTENT_FRESH_MS = 15_000;
const KEYBOARD_AUDIO_FORMAT_ENV = (process.env.EXPO_PUBLIC_KEYBOARD_AUDIO_FORMAT || 'auto')
  .trim()
  .toLowerCase();
const COMPRESSED_AUDIO_RECHECK_MS = 7 * 24 * 60 * 60 * 1000;

type KeyboardRecordingFormat = 'm4a' | 'wav';

type KeyboardStatus =
  | 'idle'
  | 'recording'
  | 'transcribing'
  | 'cleaning'
  | 'ready'
  | 'error'
  | 'no_speech'
  // Private mode but the on-device model isn't downloaded. We never fall back to
  // the cloud from the keyboard (no way to ask for consent here) — the keyboard
  // tells the user to finish setup in the app.
  | 'setup_required'
  // Agent mode: the spoken instruction transcribed; the composer is generating.
  | 'agent_generating'
  // Agent mode: generation finished and the result is written for the keyboard.
  | 'agent_ready'
  // Agent mode: transcription or generation failed (detail carries the reason,
  // e.g. usage_limit / session_expired).
  | 'agent_error';

function createKeyboardJobId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function isSelfHosted(hostBundle: string | null): boolean {
  if (!hostBundle) return false;
  const ownBundleId = Application.applicationId?.toLowerCase();
  if (!ownBundleId) return false;
  const normalized = hostBundle.trim().toLowerCase();
  return normalized === ownBundleId || normalized.startsWith(ownBundleId + '.');
}

function resolveKeyboardRecordingFormat(activeMode: string): KeyboardRecordingFormat {
  if (activeMode === 'private') {
    return 'wav';
  }
  if (KEYBOARD_AUDIO_FORMAT_ENV === 'wav') {
    return 'wav';
  }
  if (
    KEYBOARD_AUDIO_FORMAT_ENV === 'm4a' ||
    KEYBOARD_AUDIO_FORMAT_ENV === 'aac' ||
    KEYBOARD_AUDIO_FORMAT_ENV === 'compressed'
  ) {
    return 'm4a';
  }

  if (AppGroupStorage.getItem(APP_GROUP_KEYS.KEYBOARD_COMPRESSED_AUDIO_UNSUPPORTED) !== '1') {
    return 'm4a';
  }

  const unsupportedAtMs = Number(
    AppGroupStorage.getItem(APP_GROUP_KEYS.KEYBOARD_COMPRESSED_AUDIO_UNSUPPORTED_AT_MS) ?? '0',
  );
  if (!unsupportedAtMs || Date.now() - unsupportedAtMs > COMPRESSED_AUDIO_RECHECK_MS) {
    AppGroupStorage.removeItem(APP_GROUP_KEYS.KEYBOARD_COMPRESSED_AUDIO_UNSUPPORTED);
    AppGroupStorage.removeItem(APP_GROUP_KEYS.KEYBOARD_COMPRESSED_AUDIO_UNSUPPORTED_AT_MS);
    return 'm4a';
  }

  return 'wav';
}

export function useKeyboardHandoff() {
  const activeRef = useRef(false);
  const startedAtRef = useRef<number | null>(null);
  const currentJobIdRef = useRef<string | null>(null);
  const orphanCleanupInFlightRef = useRef(false);

  useEffect(() => {
    let mounted = true;

    const begin = (jobId?: string | null) => {
      activeRef.current = true;
      startedAtRef.current = Date.now();
      if (jobId) {
        currentJobIdRef.current = jobId;
      }
    };

    const readActiveJobId = () =>
      AppGroupStorage.getItem(APP_GROUP_KEYS.KEYBOARD_RECORDING_JOB_ID) || currentJobIdRef.current;

    // Job IDs embed their creation time (`${ms}-…` in the JS, keyboard, and
    // native generators), so staleness is decided by age, not strict equality:
    // the keyboard's job-id write and the app's read race across processes,
    // and a bookkeeping mismatch must never discard the transcript of the most
    // recent real recording.
    const jobTimestampMs = (jobId: string | null | undefined): number | null => {
      const ms = Number(jobId?.split('-')[0]);
      return Number.isFinite(ms) && ms > 0 ? ms : null;
    };

    const isCurrentJob = (jobId: string | null | undefined) => {
      if (!jobId) return true;
      const activeJobId = readActiveJobId();
      if (!activeJobId || activeJobId === jobId) return true;
      const jobTs = jobTimestampMs(jobId);
      const activeTs = jobTimestampMs(activeJobId);
      // Superseded only when a strictly newer job exists. Unparsable IDs keep
      // the old strict-mismatch behaviour.
      return jobTs !== null && activeTs !== null && jobTs >= activeTs;
    };

    const setCurrentJobId = (jobId: string) => {
      currentJobIdRef.current = jobId;
      AppGroupStorage.setItem(APP_GROUP_KEYS.KEYBOARD_RECORDING_JOB_ID, jobId);
    };

    const clearPendingTranscriptState = () => {
      AppGroupStorage.removeItem(APP_GROUP_KEYS.KEYBOARD_PENDING_TRANSCRIPT);
      AppGroupStorage.removeItem(APP_GROUP_KEYS.KEYBOARD_PENDING_TRANSCRIPT_JOB_ID);
      AppGroupStorage.removeItem(APP_GROUP_KEYS.KEYBOARD_ORPHANED_RAW_TRANSCRIPT);
      AppGroupStorage.removeItem(APP_GROUP_KEYS.KEYBOARD_ORPHANED_RAW_TRANSCRIPT_JOB_ID);
      AppGroupStorage.removeItem(APP_GROUP_KEYS.KEYBOARD_TRANSCRIPTION_ERROR);
    };

    const setKeyboardStatus = (status: KeyboardStatus, detail?: string) => {
      AppGroupStorage.setKeyboardStatus(status, detail ?? null);
      if (__DEV__) {
        console.log(`[keyboard-handoff] status=${status}${detail ? ` detail=${detail}` : ''}`);
      }
    };

    const prepareLocalModelIfNeeded = () => {
      const { activeMode } = useProcessingModeStore.getState();
      if (activeMode !== 'private') return;
      TranscriptionService.prepareLocal(getPreferredTranscriptionLanguage()).catch((error) => {
        if (__DEV__) {
          console.warn('[keyboard-handoff] local model warm-up failed', error);
        }
      });
    };

    const markTiming = (name: string) => {
      AppGroupStorage.markKeyboardTiming(name);
      if (__DEV__) {
        console.log(`[keyboard-handoff] timing ${name}`);
      }
    };

    const writeTimingMetric = (name: string, value: string | number | null | undefined) => {
      if (value === null || value === undefined) return;
      const serialized = typeof value === 'number' ? String(Math.round(value)) : value.trim();
      if (!serialized) return;
      AppGroupStorage.setItem(`keyboard_metric_${name}`, serialized);
    };

    const writeTranscriptionMetrics = (result: {
      endpoint?: string;
      mimeType?: string;
      fileSizeBytes?: number;
      uploadMs?: number;
      bodyBuildMs?: number;
      processingMs?: number;
      cleanupMs?: number;
      fusedCleanup?: boolean;
      serverTiming?: Record<string, string | number | boolean | null>;
    }) => {
      writeTimingMetric('endpoint', result.endpoint);
      writeTimingMetric('mime_type', result.mimeType);
      writeTimingMetric('file_size_bytes', result.fileSizeBytes);
      writeTimingMetric('upload_ms', result.uploadMs);
      writeTimingMetric('body_build_ms', result.bodyBuildMs);
      writeTimingMetric('server_processing_ms', result.processingMs);
      writeTimingMetric('cleanup_ms', result.cleanupMs);
      writeTimingMetric('fused_cleanup', result.fusedCleanup ? '1' : '0');
      if (result.serverTiming) {
        writeTimingMetric('server_timing_json', JSON.stringify(result.serverTiming));
      }
    };

    const writePendingTranscript = (text: string, jobId: string | null | undefined) => {
      const trimmed = text.trim();
      if (!trimmed) return false;
      if (jobId) {
        AppGroupStorage.setItem(APP_GROUP_KEYS.KEYBOARD_PENDING_TRANSCRIPT_JOB_ID, jobId);
      }
      if (!AppGroupStorage.setItem(APP_GROUP_KEYS.KEYBOARD_PENDING_TRANSCRIPT, trimmed)) {
        // App-group write failed (misconfigured entitlements/build). Without
        // this the transcript would vanish while the keyboard shows success.
        console.error('[keyboard-handoff] failed to write pending transcript to app group');
        setKeyboardStatus('error', 'pending_transcript_write_failed');
        return false;
      }
      markTiming('pending_transcript_written');
      setKeyboardStatus('ready');
      return true;
    };

    const cleanup = (options: { resetStatus?: boolean } = {}) => {
      activeRef.current = false;
      startedAtRef.current = null;
      useHandoffStore.getState().setActive(false);
      useHandoffStore.getState().setTranscribing(false);
      if (options.resetStatus !== false) {
        setKeyboardStatus('idle');
      }
      AppGroupStorage.endProcessingTask();
    };

    // The keyboard sets this flag when the user taps the X on the processing
    // pill. Read without clearing so the cleanup-skip checkpoint and the
    // discard checkpoint below both observe the same request.
    const isCancelRequested = () =>
      AppGroupStorage.getItem(APP_GROUP_KEYS.KEYBOARD_CANCEL_REQUESTED) === '1';

    // Cancel checkpoint for the transcription phase: discard the result and
    // return to idle without inserting anything. The keyboard also drops a late
    // transcript by job id, so correctness doesn't depend on catching every race.
    const consumeCancelDuringProcessing = (): boolean => {
      if (!isCancelRequested()) return false;
      AppGroupStorage.removeItem(APP_GROUP_KEYS.KEYBOARD_CANCEL_REQUESTED);
      if (__DEV__) {
        console.log('[keyboard-handoff] cancel requested during processing; discarding transcript');
      }
      cleanup();
      return true;
    };

    const processOrphanedRawTranscript = async (trigger: string) => {
      if (orphanCleanupInFlightRef.current) return;

      const raw = AppGroupStorage.getItem(APP_GROUP_KEYS.KEYBOARD_ORPHANED_RAW_TRANSCRIPT);
      const rawText = raw?.trim();
      if (!rawText) return;

      const rawJobId =
        AppGroupStorage.getItem(APP_GROUP_KEYS.KEYBOARD_ORPHANED_RAW_TRANSCRIPT_JOB_ID) ||
        readActiveJobId() ||
        createKeyboardJobId();
      const activeJobId = readActiveJobId();
      if (!isCurrentJob(rawJobId)) {
        if (__DEV__) {
          console.warn(
            `[keyboard-handoff] ignoring stale orphan raw transcript trigger=${trigger} jobId=${rawJobId} active=${activeJobId}`,
          );
        }
        AppGroupStorage.removeItem(APP_GROUP_KEYS.KEYBOARD_ORPHANED_RAW_TRANSCRIPT);
        AppGroupStorage.removeItem(APP_GROUP_KEYS.KEYBOARD_ORPHANED_RAW_TRANSCRIPT_JOB_ID);
        return;
      }

      orphanCleanupInFlightRef.current = true;
      setCurrentJobId(rawJobId);
      begin(rawJobId);
      setKeyboardStatus('cleaning');
      markTiming('orphan_raw_observed');

      try {
        markTiming('cleanup_start');
        // Orphan recovery bypasses transcribeAndCleanup, so apply the same
        // keyboard-dictation handling here: tone + snippet-trigger hints into
        // cleanup, then expand triggers in the final text (originalText stays raw).
        const cleaned = await cleanupTranscript(rawText, {
          tone: readKeyboardToneSnapshot(rawJobId),
          includeSnippetTriggers: true,
          context: 'keyboard',
        });
        const finalText = expandSnippets(cleaned, useSnippetsStore.getState().entries);
        markTiming('cleanup_done');

        if (isCancelRequested()) {
          AppGroupStorage.removeItem(APP_GROUP_KEYS.KEYBOARD_CANCEL_REQUESTED);
          setKeyboardStatus('idle');
          return;
        }

        if (!isCurrentJob(rawJobId)) {
          if (__DEV__) {
            console.warn(`[keyboard-handoff] dropping stale orphan cleanup jobId=${rawJobId}`);
          }
          return;
        }

        if (!finalText.trim()) {
          setKeyboardStatus('no_speech');
          return;
        }

        // The native uploader already delivered the raw text to the pending
        // slot. Upgrade it to the cleaned text only if the keyboard hasn't
        // consumed it yet; otherwise the raw text was already inserted and
        // re-writing pending would paste a second time.
        const pendingUndelivered = !!AppGroupStorage.getItem(
          APP_GROUP_KEYS.KEYBOARD_PENDING_TRANSCRIPT,
        );
        if (pendingUndelivered) {
          writePendingTranscript(finalText, rawJobId);
          await Clipboard.setStringAsync(finalText);
        }

        // Persist to history regardless of delivery path (background uploads
        // are always cloud).
        await useTranscriptStore.getState().addTranscript({
          text: finalText,
          originalText: rawText,
          provider: 'cloud',
          requestContext: 'keyboard',
        });
      } catch (error) {
        if (isCurrentJob(rawJobId)) {
          setKeyboardStatus('error', error instanceof Error ? error.message : 'cleanup_error');
        }
      } finally {
        AppGroupStorage.removeItem(APP_GROUP_KEYS.KEYBOARD_ORPHANED_RAW_TRANSCRIPT);
        AppGroupStorage.removeItem(APP_GROUP_KEYS.KEYBOARD_ORPHANED_RAW_TRANSCRIPT_JOB_ID);
        orphanCleanupInFlightRef.current = false;
        cleanup({ resetStatus: false });
      }
    };

    const runOrphanCleanup = (trigger: string) => {
      processOrphanedRawTranscript(trigger).catch((error) => {
        if (__DEV__) {
          console.warn(`[keyboard-handoff] orphan cleanup failed trigger=${trigger}`, error);
        }
      });
    };

    const handleUrl = (incomingUrl: string | null | undefined) => {
      if (!incomingUrl) return;

      let route = '';
      let returnScheme: string | null = null;
      let hostBundle: string | null = null;
      let intent: string | null = null;
      try {
        const parsed = new URL(incomingUrl);
        const normalizedPath = parsed.pathname.replace(/^\/+/, '').toLowerCase();
        const normalizedHost = parsed.host.toLowerCase();
        route = normalizedPath || normalizedHost;
        returnScheme = parsed.searchParams?.get('returnScheme') ?? null;
        hostBundle = parsed.searchParams?.get('hostBundle') ?? null;
        intent = parsed.searchParams?.get('intent')?.toLowerCase() ?? null;
      } catch {
        return;
      }
      // expo-router navigates to the recovery screen on its own, so there is no
      // recording and no handoff state to set up. The stamp is the one thing that
      // must happen here rather than in the screen: the warm-resume reset runs off
      // `didBecomeActive` and would otherwise replace the screen with Home before
      // its mount effect could claim it.
      if (route === KEYBOARD_FULL_ACCESS_ROUTE) {
        useKeyboardRecoveryStore.getState().markRecoveryDeepLink();
        return;
      }
      if (route !== KEYBOARD_DICTATION_ROUTE) return;

      // This URL supersedes any pending Activate-tap intent stamped by the
      // keyboard — consume it so the fallback path can't double-start.
      AppGroupStorage.removeItem(APP_GROUP_KEYS.KEYBOARD_HANDOFF_INTENT_AT_MS);

      const selfHosted = isSelfHosted(hostBundle);

      // Regenerate wake-link (app was dead): the keyboard wrote keyboard_agent_action
      // before opening this URL. Replay it through the existing cold-start action
      // path — NOT a recording. The composer writes its own agent_ready/agent_error;
      // bounce the user back to the app they were in (the keyboard surfaces the
      // result there). This is the phantom-recording-free regenerate recovery path.
      if (intent === 'agent-action') {
        runAgentAction(`url:${intent}`);
        if (!selfHosted) {
          AppGroupStorage.returnToPreviousApp();
        }
        return;
      }

      if (activeRef.current) {
        const startedAt = startedAtRef.current;
        if (!startedAt || Date.now() - startedAt < HANDOFF_THROTTLE_MS) {
          // A job is mid-flight; don't preempt it — but don't strand the user
          // in OpenWhispr either. Bounce back so the keyboard shows the live
          // recording/transcribing state instead of a dead tap.
          if (!selfHosted) {
            AppGroupStorage.returnToPreviousApp();
          }
          return;
        }
        cleanup();
      }

      const { activeMode } = useProcessingModeStore.getState();
      const recordingFormat = resolveKeyboardRecordingFormat(activeMode);

      const jobId = createKeyboardJobId();
      setCurrentJobId(jobId);
      begin(jobId);
      snapshotKeyboardTone(jobId);
      // Snapshot any pending keyboard_agent_request into a per-job record.
      // Returns null (no-op) for normal dictation; idempotent per jobId.
      snapshotKeyboardAgentRequest(jobId);
      markTiming('handoff_begin');
      AppGroupStorage.setItem(APP_GROUP_KEYS.KEYBOARD_RECORDING_FORMAT, recordingFormat);
      writeTimingMetric('recording_format_requested', recordingFormat);
      if (!selfHosted) {
        useHandoffStore.getState().setActive(true);
        // Activating dictation from another app turns dictation mode on. That
        // keeps the Dynamic Island pill alive across this and future dictations
        // (a persistent session activity, not one recreated per recording) and
        // warms the mic so the next handoff records without a cold start.
        // Idempotent when already on.
        LiveActivity.setDictationMode(true);
      }
      clearPendingTranscriptState();
      setKeyboardStatus('recording');
      prepareLocalModelIfNeeded();

      const trimmedReturn = returnScheme?.trim();
      if (trimmedReturn) AppGroupStorage.setItem('keyboard_return_url', trimmedReturn);
      const trimmedHost = hostBundle?.trim();
      if (trimmedHost) AppGroupStorage.setItem('keyboard_return_bundle', trimmedHost);

      const started = AppGroupStorage.startNativeRecording();
      if (!started) {
        if (__DEV__) console.log('[keyboard-handoff] startNativeRecording failed');
        setKeyboardStatus('error', 'start_native_recording_failed');
        cleanup({ resetStatus: false });
        // Return the user to the app they were dictating into — the keyboard
        // surfaces the error state there. Leaving them in OpenWhispr with no
        // visible failure is the worst outcome.
        if (!selfHosted) {
          AppGroupStorage.returnToPreviousApp();
        }
        return;
      }

      LiveActivity.startSession();

      if (!selfHosted) {
        AppGroupStorage.returnToPreviousApp();
      }
    };

    // Regenerate (keyboard_agent_action): a one-shot poke, not a recording. The
    // keyboard wrote the action + its at-ms twin and pokes .agentAction; on cold
    // launch the same action is replayed via handlePendingHandoffIntent below.
    // Consume both keys, then hand off to the composer, which writes the result
    // and its own terminal agent_ready/agent_error (no native recording or
    // processing task is involved, so there's nothing to begin()/cleanup()).
    const runAgentAction = (trigger: string) => {
      const action = consumeKeyboardAgentAction();
      if (!action) return;
      if (__DEV__) {
        console.log(
          `[keyboard-handoff] agent action trigger=${trigger} session=${action.sessionId} requestId=${action.requestId}`,
        );
      }
      handleAgentAction(action, {
        setKeyboardStatus: (status, detail) => setKeyboardStatus(status as KeyboardStatus, detail),
      }).catch((error) => {
        console.error('[keyboard-handoff] agent action failed:', error);
        setKeyboardStatus('agent_error', error instanceof Error ? error.message : 'agent_error');
      });
    };

    // Fallback for lost deep links: the keyboard stamps an intent timestamp on
    // every Activate tap. On cold launch `Linking.getInitialURL()` can resolve
    // null (and warm `url` events can occasionally be dropped), which today
    // means the app opens and silently does nothing. If a fresh intent exists
    // and no URL claimed it, synthesize the same handoff from the host info the
    // keyboard already stored in the App Group.
    const handlePendingHandoffIntent = (trigger: string) => {
      // Cold-start replay for a lost .agentAction poke. Independent of the
      // recording handoff below, so it runs before the activeRef guard: a
      // mid-flight recording must not swallow a queued regenerate. The freshness
      // (<15s) + one-shot clear both live in consumeKeyboardAgentAction.
      runAgentAction(`intent:${trigger}`);

      if (activeRef.current) return;
      const raw = AppGroupStorage.getItem(APP_GROUP_KEYS.KEYBOARD_HANDOFF_INTENT_AT_MS);
      if (!raw) return;
      AppGroupStorage.removeItem(APP_GROUP_KEYS.KEYBOARD_HANDOFF_INTENT_AT_MS);
      const intentAtMs = Number(raw);
      if (!Number.isFinite(intentAtMs) || Date.now() - intentAtMs > HANDOFF_INTENT_FRESH_MS) {
        return;
      }
      markTiming('handoff_intent_fallback');
      if (__DEV__) {
        console.log(`[keyboard-handoff] handoff intent fallback trigger=${trigger}`);
      }
      const hostBundle = AppGroupStorage.getItem('keyboard_return_bundle');
      const params = hostBundle
        ? `?source=keyboard-intent&hostBundle=${encodeURIComponent(hostBundle)}`
        : '?source=keyboard-intent';
      handleUrl(`openwhispr://${KEYBOARD_DICTATION_ROUTE}${params}`);
    };

    const stoppedSub = addRecordingStoppedListener(
      async ({
        fileUri,
        fileName,
        mimeType,
        recordingFormat,
        jobId: stoppedJobId,
        fileSizeBytes,
        recordingDurationMs,
      }) => {
        const jobId = stoppedJobId?.trim() || readActiveJobId() || createKeyboardJobId();
        if (!isCurrentJob(jobId)) {
          if (__DEV__) {
            console.warn(`[keyboard-handoff] ignoring stale recording stopped jobId=${jobId}`);
          }
          return;
        }

        setCurrentJobId(jobId);
        begin(jobId);
        markTiming('recording_stopped_event');
        setKeyboardStatus('transcribing');
        if (__DEV__) {
          console.log(
            `[keyboard-handoff] recording stopped fileSize=${fileSizeBytes ?? 'unknown'} durationMs=${
              recordingDurationMs ?? 'unknown'
            } format=${recordingFormat ?? 'unknown'} mime=${mimeType ?? 'unknown'} jobId=${jobId}`,
          );
        }
        writeTimingMetric('recording_file_size_bytes', fileSizeBytes);
        writeTimingMetric('recording_duration_ms', recordingDurationMs);
        writeTimingMetric('recording_format', recordingFormat);
        writeTimingMetric('recording_mime_type', mimeType);
        // Was this a cancel from the keyboard? If so, skip transcription entirely.
        const cancelRequested =
          AppGroupStorage.getItem(APP_GROUP_KEYS.KEYBOARD_CANCEL_REQUESTED) === '1';
        AppGroupStorage.removeItem(APP_GROUP_KEYS.KEYBOARD_CANCEL_REQUESTED);
        if (cancelRequested) {
          cleanup();
          return;
        }
        useHandoffStore.getState().setTranscribing(true);
        const { activeMode } = useProcessingModeStore.getState();
        const { addFailedTranscript, addTranscript } = useTranscriptStore.getState();
        const provider = activeMode === 'private' ? 'local' : 'cloud';
        const transcriptId = jobId;
        const keyboardTone = readKeyboardToneSnapshot(jobId);
        let retainedAudioUrl: string | null = null;

        const flagNoSpeech = () => {
          markTiming('no_speech_detected');
          setKeyboardStatus('no_speech');
          useHandoffStore.getState().setNoSpeechDetected(true);
          setTimeout(() => {
            useHandoffStore.getState().setNoSpeechDetected(false);
            cleanup();
          }, NO_SPEECH_DISPLAY_MS);
        };
        const deleteRetainedAudio = () => {
          if (!retainedAudioUrl) return;
          deleteManagedTranscriptAudio(retainedAudioUrl).catch((error) => {
            if (__DEV__) {
              console.warn('[keyboard-handoff] failed to delete retained audio:', error);
            }
          });
        };

        // Agent job path: the recorded audio is a *spoken instruction*, not
        // dictation to insert. Transcribe it RAW (no cleanup — so the wake-word
        // agentName detection that lives in cleanupTranscript never fires — no
        // snippets, no history/pending-transcript write, no insert) and hand the
        // instruction to the composer, which writes the result and the terminal
        // agent_ready/agent_error status itself and validates job currency. As
        // with the normal path, endProcessingTask (via cleanup) is deferred to
        // the terminal path, so the keyboard never polls a stale agent_generating.
        const runAgentJob = async (job: KeyboardAgentJob): Promise<void> => {
          try {
            markTiming('agent_transcribe_start');
            const transcription = await TranscriptionService.transcribe({
              audioUri: fileUri,
              provider,
              language: getPreferredTranscriptionLanguage(),
              fileName,
              mimeType,
              jobId,
              requestContext: 'keyboard',
              keyboardTone,
            });
            writeTranscriptionMetrics(transcription);
            markTiming('agent_transcribe_done');

            // Cancelled while transcribing: discard and return to idle.
            // consumeCancelDuringProcessing() already ran cleanup().
            if (consumeCancelDuringProcessing()) {
              if (readKeyboardAgentJob(jobId)) clearKeyboardAgentJob();
              return;
            }

            const instruction = transcription.text.trim();
            if (!instruction) {
              // Empty instruction ⇒ the same no_speech UX the normal path shows.
              // flagNoSpeech() owns the deferred cleanup().
              if (readKeyboardAgentJob(jobId)) clearKeyboardAgentJob();
              flagNoSpeech();
              return;
            }

            // A newer recording superseded this job while we transcribed: drop
            // silently. The newer job owns the agent-job key and the processing
            // lifecycle now, so don't clear the key and don't run cleanup —
            // mirrors the normal path's stale-final-transcript branch.
            if (!isCurrentJob(jobId)) {
              if (__DEV__) {
                console.warn(`[keyboard-handoff] dropping stale agent transcript jobId=${jobId}`);
              }
              return;
            }

            setKeyboardStatus('agent_generating');
            markTiming('agent_generating');
            // generateForJob writes the result + agent_ready/agent_error itself
            // and re-checks job currency before writing. Its config setter is
            // typed as (string, ...) since it lives outside this hook; it only
            // ever emits agent_ready/agent_error, both members of KeyboardStatus.
            await generateForJob(job, instruction, {
              setKeyboardStatus: (status, detail) =>
                setKeyboardStatus(status as KeyboardStatus, detail),
            });
            if (readKeyboardAgentJob(jobId)) clearKeyboardAgentJob();
            cleanup({ resetStatus: false });
          } catch (error) {
            if (isNoSpeechError(error)) {
              if (readKeyboardAgentJob(jobId)) clearKeyboardAgentJob();
              flagNoSpeech();
              return;
            }
            // Never leave the keyboard stuck at agent_generating: any transcribe
            // failure on the agent path surfaces as agent_error.
            console.error('[keyboard-handoff] agent transcription error:', error);
            setKeyboardStatus('agent_error', toFriendlyTranscriptionErrorMessage(error));
            if (readKeyboardAgentJob(jobId)) clearKeyboardAgentJob();
            cleanup({ resetStatus: false });
          }
        };
        const addFailedKeyboardTranscript = async (error: unknown) => {
          if (!retainedAudioUrl) return;
          try {
            await addFailedTranscript({
              id: transcriptId,
              audioUrl: retainedAudioUrl,
              audioFileName: fileName,
              audioMimeType: mimeType,
              duration: recordingDurationMs ? recordingDurationMs / 1000 : undefined,
              provider,
              requestContext: 'keyboard',
              keyboardTone,
              jobId,
              errorMessage: toFriendlyTranscriptionErrorMessage(error),
            });
          } catch (failedRowError) {
            if (__DEV__) {
              console.warn(
                '[keyboard-handoff] failed to save retryable failed transcript:',
                failedRowError,
              );
            }
          }
        };

        // Null for normal dictation (no snapshot was taken at record-start) —
        // every branch below is keyed off this being non-null, so the normal
        // pipeline is unchanged. Read once and share with the VAD exit.
        const agentJob = readKeyboardAgentJob(jobId);

        try {
          markTiming('vad_start');
          const speechAnalysis = await analyzeSpeechActivity(fileUri, 'keyboard');
          markTiming('vad_done');
          if (speechAnalysis) {
            Object.entries(serializeSpeechActivityMetrics(speechAnalysis)).forEach(
              ([key, value]) => {
                writeTimingMetric(key, value);
              },
            );
            if (speechAnalysis.noSpeechLikely) {
              if (__DEV__) {
                console.log(
                  `[keyboard-handoff] local VAD skipped transcription reason=${
                    speechAnalysis.reason ?? 'unknown'
                  }`,
                );
              }
              if (agentJob && readKeyboardAgentJob(jobId)) clearKeyboardAgentJob();
              flagNoSpeech();
              return;
            }
          }

          if (agentJob) {
            await runAgentJob(agentJob);
            return;
          }

          retainedAudioUrl = await retainTranscriptAudio(fileUri, {
            transcriptId,
            audioFileName: fileName,
            audioMimeType: mimeType,
          });

          let transcribeStartedAt = Date.now();
          let cleanupStartedAt = Date.now();
          const processed = await transcribeAndCleanup(
            {
              audioUri: retainedAudioUrl,
              provider,
              language: getPreferredTranscriptionLanguage(),
              fileName,
              mimeType,
              jobId,
              requestContext: 'keyboard',
              keyboardTone,
            },
            {
              shouldCancel: isCancelRequested,
              onStage: (stage, details) => {
                if (stage === 'transcribing') {
                  transcribeStartedAt = Date.now();
                  setKeyboardStatus('transcribing');
                  markTiming('transcribe_start');
                  if (details?.fusedCleanup) {
                    markTiming('cleanup_start');
                    markTiming('transcribe_cleanup_start');
                  }
                  return;
                }

                cleanupStartedAt = Date.now();
                setKeyboardStatus('cleaning');
                markTiming('cleanup_start');
              },
              onTranscribeDone: (result) => {
                writeTranscriptionMetrics(result);
                markTiming('transcribe_done');
                if (result.fusedCleanup) {
                  markTiming('cleanup_done');
                  markTiming('transcribe_cleanup_done');
                }
                if (__DEV__) {
                  console.log(
                    `[keyboard-handoff] transcribe provider=${provider} endpoint=${
                      result.endpoint ?? 'local'
                    } fused=${result.fusedCleanup ? '1' : '0'} elapsedMs=${
                      Date.now() - transcribeStartedAt
                    } serverMs=${result.processingMs ?? 'unknown'} cleanupMs=${
                      result.cleanupMs ?? 'unknown'
                    } uploadMs=${result.uploadMs ?? 'unknown'} bodyBuildMs=${
                      result.bodyBuildMs ?? 'unknown'
                    }`,
                  );
                }
              },
              onCleanupDone: (result) => {
                if (!result.fusedCleanup) {
                  markTiming('cleanup_done');
                  writeTimingMetric('cleanup_elapsed_ms', Date.now() - cleanupStartedAt);
                }
                if (__DEV__) {
                  console.log(
                    `[keyboard-handoff] cleanup fused=${result.fusedCleanup ? '1' : '0'} elapsedMs=${
                      result.fusedCleanup
                        ? (result.cleanupMs ?? 'unknown')
                        : Date.now() - cleanupStartedAt
                    }`,
                  );
                }
              },
              onFusedCleanupFallback: (error) => {
                markTiming('fused_cleanup_fallback');
                if (__DEV__) {
                  console.warn(
                    '[keyboard-handoff] fused cleanup unavailable; using serial cleanup',
                    error,
                  );
                }
              },
            },
          );

          // Cancelled during transcription/cleanup: drop the result, stay idle.
          if (consumeCancelDuringProcessing()) {
            deleteRetainedAudio();
            return;
          }

          if (!processed.originalText.trim()) {
            deleteRetainedAudio();
            flagNoSpeech();
            return;
          }

          const finalText = processed.text;
          const trimmed = finalText.trim();
          if (!trimmed) {
            deleteRetainedAudio();
            flagNoSpeech();
            return;
          }
          if (!isCurrentJob(jobId)) {
            if (__DEV__) {
              console.warn(`[keyboard-handoff] dropping stale final transcript jobId=${jobId}`);
            }
            deleteRetainedAudio();
            return;
          }
          writePendingTranscript(finalText, jobId);
          await Clipboard.setStringAsync(finalText);

          await addTranscript({
            id: transcriptId,
            text: finalText,
            originalText: processed.originalText,
            audioUrl: retainedAudioUrl,
            audioFileName: fileName,
            audioMimeType: mimeType,
            duration: processed.transcription.duration,
            provider: processed.transcription.provider,
            requestContext: 'keyboard',
            keyboardTone,
            jobId,
          });
          cleanup({ resetStatus: false });
        } catch (error) {
          if (isNoSpeechError(error)) {
            deleteRetainedAudio();
            flagNoSpeech();
            return;
          }
          // Private mode with no on-device model. Never upload from the keyboard
          // without consent — surface a setup prompt the user resolves in the app.
          if (provider === 'local' && isLocalModelMissingError(error)) {
            await addFailedKeyboardTranscript(error);
            setKeyboardStatus('setup_required');
            cleanup({ resetStatus: false });
            return;
          }
          // Handled + retryable: a failed row is saved and the keyboard shows its
          // "Try again" state, so log as a dev warning (not console.error) to avoid
          // a red LogBox toast for an expected condition like being offline.
          if (__DEV__) {
            console.warn('[keyboard-handoff] Transcription error:', error);
          }
          await addFailedKeyboardTranscript(error);
          setKeyboardStatus('error', toFriendlyTranscriptionErrorMessage(error));
          cleanup({ resetStatus: false });
        }
      },
    );

    const errorSub = addRecordingErrorListener(({ message }) => {
      begin();
      console.error('[keyboard-handoff] onRecordingError:', message);
      setKeyboardStatus('error', message);
      cleanup({ resetStatus: false });
    });

    const bgStartedSub = addBackgroundRecordingStartedListener(() => {
      const bgJobId = readActiveJobId();
      begin(bgJobId);
      if (bgJobId) {
        snapshotKeyboardTone(bgJobId);
        // Mirror the tone snapshot: capture a pending agent request for this
        // job. No-op (null) when none is pending; idempotent per jobId.
        snapshotKeyboardAgentRequest(bgJobId);
      }
      markTiming('background_recording_started');
      setKeyboardStatus('recording');
      // Raise the Dynamic Island pill from the app while it's foreground — iOS
      // only allows *starting* a Live Activity from the foreground. This covers
      // in-app dictation (records in place) and the handoff redirect that just
      // brought us active. Idempotent with the redirect's own startSession().
      // Pure background dictation (warm mic, no app switch) can't start one and
      // would need push-to-start; an already-running session activity still
      // flips to "recording" via the native status observer.
      if (AppState.currentState === 'active') {
        LiveActivity.startSession();
      }
      prepareLocalModelIfNeeded();
    });

    const statusSub = addKeyboardStatusChangedListener((event) => {
      if (!event.hasOrphanedRawTranscript) return;
      runOrphanCleanup(`status_event:${event.trigger ?? event.status ?? 'unknown'}`);
    });

    // Warm-path regenerate poke: the keyboard posts .agentAction after writing
    // the action key. Consume + hand to the composer. Cold-start replay of a
    // dropped poke is handled by handlePendingHandoffIntent.
    const agentActionSub = addAgentActionListener(() => runAgentAction('poke'));

    runOrphanCleanup('mount');
    const orphanPoll = setInterval(() => {
      runOrphanCleanup('watchdog');
    }, 15_000);

    const urlSub = Linking.addEventListener('url', ({ url }) => handleUrl(url));
    const appStateSub = AppState.addEventListener('change', (state) => {
      if (state === 'active') handlePendingHandoffIntent('app_state_active');
    });

    Linking.getInitialURL()
      .then((url) => {
        if (mounted && url) handleUrl(url);
      })
      .catch((error) => {
        console.warn('[keyboard-handoff] Failed to read initial URL:', error);
      })
      .finally(() => {
        if (!mounted) return;
        // Cold launch where the deep link was lost: the URL above (when
        // delivered) consumes the intent first, making this a no-op.
        handlePendingHandoffIntent('initial_url');
        useHandoffStore.getState().setCheckingInitialUrl(false);
      });

    return () => {
      mounted = false;
      stoppedSub?.remove();
      errorSub?.remove();
      bgStartedSub?.remove();
      statusSub?.remove();
      agentActionSub?.remove();
      urlSub.remove();
      appStateSub.remove();
      clearInterval(orphanPoll);
    };
  }, []);
}
