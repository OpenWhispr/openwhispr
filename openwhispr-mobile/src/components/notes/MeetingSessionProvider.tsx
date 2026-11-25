import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type React from 'react';
import * as FileSystem from 'expo-file-system/legacy';
import { notesRepository } from '@/data';
import type { Note } from '@/data/types';
import { useAudioRecording } from '@/hooks/useAudioRecording';
import { useCloudMeeting, type CloudMeeting } from '@/hooks/useCloudMeeting';
import { useMeetingLiveActivity, type MeetingActivityPhase } from '@/hooks/useMeetingLiveActivity';
import { useMeetingRecorderHealth } from '@/hooks/useMeetingRecorderHealth';
import type { buildCalendarMeetingContext } from '@/lib/calendar/meetingContext';
import { canTransition } from '@/lib/diarization/transcriptionStatus';
import {
  alertCloudMeetingCapture,
  alertIfPartialCapture,
  useCapturePausedNotification,
} from '@/lib/meetingCaptureAlerts';
import { reportCaptureInterrupted, reportMeetingFinished } from '@/lib/meetingCaptureTelemetry';
import { registerActiveMeeting } from '@/lib/notes/activeMeeting';
import { captureMeetingAccount, type MeetingAccountFence } from '@/lib/notes/meetingAccountFence';
import { captureCoverage, isCloudMeetingCapturing } from '@/lib/notes/meetingCapture';
import { Sentry } from '@/lib/sentry';
import { excludeMeetingFileFromBackup, meetingRecordingUri } from '@/lib/transcriptAudio';
import { getPreferredTranscriptionLanguage } from '@/lib/transcriptionLanguage';
import { useAuthStore } from '@/store/useAuthStore';
import { useNotesStore } from '@/store/useNotesStore';
import type { TranscriptionStatus } from '@/types';

export type MeetingSessionPhase = 'idle' | 'recording' | 'cloud-recording' | 'processing';

export interface MeetingStartInput {
  expectedSpeakerCount?: number;
  folderId?: number;
  spaceId?: number;
  context: ReturnType<typeof buildCalendarMeetingContext> | null;
}

export interface MeetingSession {
  phase: MeetingSessionPhase;
  path: 'local' | 'cloud';
  noteId: number | null;
  title: string | null;
  expectedSpeakerCount: number | undefined;
  capturing: boolean;
  capturedSeconds: number;
  /** True while startLocal waits for the recorder, before the phase leaves 'idle'. */
  starting: boolean;
  cloud: Pick<CloudMeeting, 'status' | 'error' | 'utterances' | 'partialText' | 'liveSinceMs'>;
  rawNotes: string;
  setRawNotes: (text: string) => void;
  startLocal: (input: MeetingStartInput) => Promise<boolean>;
  startCloud: (input: MeetingStartInput) => boolean;
  stop: () => Promise<void>;
  finishedNoteId: number | null;
  acknowledgeFinished: () => void;
}

const MeetingSessionContext = createContext<MeetingSession | null>(null);
// The session value changes every second (captured time, captions). Surfaces that only need to
// know which note is recording read this one, whose value changes only when a meeting starts or ends.
const LiveMeetingNoteContext = createContext<number | null>(null);

/**
 * Owns the meeting recording for the whole app, so leaving the recording screen (Back, a tab
 * switch) never ends a meeting. Mounted in the root layout above the auth switch; the screen and
 * any other surface are views of this session.
 */
export function MeetingSessionProvider({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  const [phase, setPhaseState] = useState<MeetingSessionPhase>('idle');
  const [noteId, setNoteId] = useState<number | null>(null);
  const [title, setTitle] = useState<string | null>(null);
  const [expectedSpeakerCount, setExpectedSpeakerCount] = useState<number | undefined>(undefined);
  // Wall-clock start of the current meeting (local or cloud): starts the Live Activity and
  // measures, at Stop, how much of the meeting the recording covers.
  const [meetingStartedAt, setMeetingStartedAt] = useState<number | null>(null);
  // Which recorder the current meeting uses, so processing still reads that one's clock.
  const [path, setPath] = useState<'local' | 'cloud'>('local');
  const [rawNotes, setRawNotesState] = useState('');
  const [finishedNoteId, setFinishedNoteId] = useState<number | null>(null);
  const lastSavedRawNotesRef = useRef('');
  // The utterance and error callbacks outlive renders; the note is created just before the phase flips.
  const noteIdRef = useRef<number | null>(null);
  // Written with the state, never from a render: a finish started from outside React (sign-out)
  // can run before the render that follows a start has committed.
  const meetingStartedAtRef = useRef<number | null>(null);
  const expectedSpeakerCountRef = useRef<number | undefined>(undefined);
  const rawNotesRef = useRef('');
  // The account the meeting was started under, held to the end: processing steps that would use
  // the signed-in account's credentials or data skip themselves once it changes.
  const accountFenceRef = useRef<MeetingAccountFence | null>(null);
  // Written with the state so two starts in one tick can't both read 'idle'.
  const phaseRef = useRef<MeetingSessionPhase>('idle');
  // Covers the wait for the recorder in startLocal, before the phase leaves 'idle'.
  const startingRef = useRef(false);
  // The same wait, for views: a screen opened meanwhile must not offer a second start.
  const [starting, setStarting] = useState(false);

  const setPhase = useCallback((next: MeetingSessionPhase): void => {
    phaseRef.current = next;
    setPhaseState(next);
  }, []);

  const updateNote = useNotesStore((s) => s.updateNote);
  const createMeetingNote = useNotesStore((s) => s.createMeetingNote);
  const transitionStatus = useNotesStore((s) => s.transitionStatus);
  const runMeetingPipeline = useNotesStore((s) => s.runMeetingPipeline);
  const finalizeCloudMeeting = useNotesStore((s) => s.finalizeCloudMeeting);
  const appendCloudMeetingUtterance = useNotesStore((s) => s.appendCloudMeetingUtterance);

  // Mark an in-flight note failed when we abandon a recording (guarded: skip if already terminal,
  // since processMeeting may have set 'failed' directly).
  const markNoteFailed = (id: number): void => {
    const status = useNotesStore.getState().notes.find((n) => n.id === id)?.transcriptionStatus;
    if (status != null && canTransition(status as TranscriptionStatus, 'failed')) {
      transitionStatus(id, 'failed');
    }
  };
  const markNoteFailedRef = useRef(markNoteFailed);
  markNoteFailedRef.current = markNoteFailed;

  // The recorder's onError is built before `recording` exists; this is how it reaches the cancel.
  const cancelRecordingRef = useRef<() => Promise<void>>(() => Promise.resolve());
  const recording = useAudioRecording({
    allowsBackgroundRecording: true,
    onError: () => {
      // Only a local capture is this recorder's to tear down. A late error while processing or
      // during a cloud meeting must not reset a meeting that is still being finished.
      if (phaseRef.current !== 'recording' && !startingRef.current) return;
      // A start that fails has no note yet; one that fails mid-meeting must not stay "recording".
      const currentNoteId = noteIdRef.current;
      if (currentNoteId != null) markNoteFailedRef.current(currentNoteId);
      // Stops the recorder and releases the meeting-local lease, which would otherwise keep
      // refusing every dictation until the next meeting.
      cancelRecordingRef.current().catch((error) => Sentry.captureException(error));
      returnToIdle();
    },
  });
  cancelRecordingRef.current = recording.cancelRecording;
  const cloudMeeting = useCloudMeeting({
    enabled: phase === 'cloud-recording',
    language: getPreferredTranscriptionLanguage(),
    // The note exists before the session starts, so the recording has its own path from the start.
    recordingUri: noteId != null ? meetingRecordingUri(noteId) : undefined,
    onUtterance: (utterance, index, capturedMs) => {
      const currentNoteId = noteIdRef.current;
      if (currentNoteId != null) {
        appendCloudMeetingUtterance(currentNoteId, utterance, index, capturedMs);
      }
    },
  });

  const recorderHealth = useMeetingRecorderHealth(
    recording.audioRecorder,
    phase === 'recording',
    recording.canResumeRecording,
  );
  // One capture state and clock for both recorders, read by every view, the lock screen and
  // the paused notification.
  const capturing =
    path === 'cloud' ? isCloudMeetingCapturing(cloudMeeting.status) : recorderHealth.capturing;
  const capturedSeconds =
    path === 'cloud' ? cloudMeeting.capturedSeconds : Math.floor(recorderHealth.capturedMs / 1000);

  // On-device interruptions this meeting, for the finish report. The cloud hook counts its own.
  const localInterruptionsRef = useRef(0);
  // Stop, the lock screen's End and the notification can all ask to finish; a second finish
  // would stop an already stopped recorder and overwrite the first one's result mid-flight.
  const finishingRef = useRef(false);
  // The running finish, for callers that must wait on it rather than only start it.
  const inFlightFinishRef = useRef<{
    path: 'local' | 'cloud';
    captured: Promise<void>;
    done: Promise<void>;
  } | null>(null);
  const wasLocalCapturingRef = useRef(false);
  useEffect(() => {
    if (phase !== 'recording') {
      wasLocalCapturingRef.current = false;
      return;
    }
    if (wasLocalCapturingRef.current && !capturing) {
      localInterruptionsRef.current += 1;
      reportCaptureInterrupted({
        path: 'local',
        reason: 'recorder_stopped',
        capturedSeconds,
      });
    }
    wasLocalCapturingRef.current = capturing;
    // Only the capturing edge matters; capturedSeconds is read at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, capturing]);

  useEffect(() => {
    if (
      (phase !== 'recording' && phase !== 'cloud-recording') ||
      noteId == null ||
      rawNotes === lastSavedRawNotesRef.current
    ) {
      return;
    }

    const timeout = setTimeout(() => {
      updateNote(noteId, { content: rawNotes });
      lastSavedRawNotesRef.current = rawNotes;
    }, 800);
    return () => clearTimeout(timeout);
  }, [noteId, phase, rawNotes, updateNote]);

  const setRawNotes = useCallback((text: string): void => {
    rawNotesRef.current = text;
    setRawNotesState(text);
  }, []);

  const saveRawNotesNow = (): void => {
    const currentNoteId = noteIdRef.current;
    const text = rawNotesRef.current;
    if (currentNoteId == null || text === lastSavedRawNotesRef.current) return;
    updateNote(currentNoteId, { content: text });
    lastSavedRawNotesRef.current = text;
  };

  // Shared tail of both starts, once the note exists.
  const enterMeeting = (
    note: Note,
    input: MeetingStartInput,
    meetingPath: 'local' | 'cloud',
  ): void => {
    setRawNotes(note.content);
    lastSavedRawNotesRef.current = note.content;
    noteIdRef.current = note.id;
    setNoteId(note.id);
    meetingStartedAtRef.current = Date.now();
    expectedSpeakerCountRef.current = input.expectedSpeakerCount;
    accountFenceRef.current = captureMeetingAccount();
    setTitle(input.context?.title ?? null);
    setExpectedSpeakerCount(input.expectedSpeakerCount);
    setMeetingStartedAt(meetingStartedAtRef.current);
    setPath(meetingPath);
    setFinishedNoteId(null);
  };

  const isIdle = (): boolean => phaseRef.current === 'idle' && !startingRef.current;

  // Create the note only AFTER recording actually starts, so a denied mic permission / recorder
  // failure doesn't leave an orphan "recording" note behind (startRecording re-throws on failure).
  const startLocalInner = async (input: MeetingStartInput): Promise<boolean> => {
    if (!isIdle()) return false;
    startingRef.current = true;
    setStarting(true);
    try {
      try {
        await recording.startRecording();
      } catch {
        return false;
      }
      const context = input.context;
      let note: Note;
      try {
        note = createMeetingNote({
          folderId: input.folderId,
          spaceId: input.spaceId,
          expectedSpeakerCount: input.expectedSpeakerCount,
          calendarEventId: context?.calendarEventId ?? null,
          title: context?.title ?? null,
          participants: context?.participants ?? null,
        });
      } catch (error) {
        Sentry.captureException(error, {
          tags: {
            feature: 'meeting-calendar-context',
            calendar_context_operation: 'create_meeting_note',
            calendar_context_selected: !!context,
          },
        });
        await recording.cancelRecording().catch((cancelError) => {
          Sentry.captureException(cancelError, {
            tags: {
              feature: 'meeting-calendar-context',
              calendar_context_operation: 'cancel_after_context_failure',
            },
          });
        });
        return false;
      }
      enterMeeting(note, input, 'local');
      localInterruptionsRef.current = 0;
      setPhase('recording');
      return true;
    } finally {
      startingRef.current = false;
      setStarting(false);
    }
  };

  // Kept so a non-React stop can wait for a start that is still waiting on the recorder.
  const startPromiseRef = useRef<Promise<boolean> | null>(null);
  const startLocal = (input: MeetingStartInput): Promise<boolean> => {
    const started = startLocalInner(input);
    if (startingRef.current) startPromiseRef.current = started;
    return started;
  };

  // Cloud meetings don't pre-check the mic (the realtime session requests it); the note is
  // created up front so live captions have somewhere to land. A session that never connects
  // is resolved on Stop (finishCloud) as failed rather than a done, empty note.
  const startCloud = (input: MeetingStartInput): boolean => {
    if (!isIdle()) return false;
    const context = input.context;
    let note: Note;
    try {
      note = createMeetingNote({
        folderId: input.folderId,
        spaceId: input.spaceId,
        expectedSpeakerCount: input.expectedSpeakerCount,
        calendarEventId: context?.calendarEventId ?? null,
        title: context?.title ?? null,
        participants: context?.participants ?? null,
        diarizationEnabled: false, // cloud realtime returns a flat transcript (no speakers)
      });
    } catch (error) {
      Sentry.captureException(error, {
        tags: {
          feature: 'meeting-calendar-context',
          calendar_context_operation: 'create_cloud_meeting_note',
          calendar_context_selected: !!context,
        },
      });
      return false;
    }
    enterMeeting(note, input, 'cloud');
    setPhase('cloud-recording');
    return true;
  };

  // The meeting is over, finished or abandoned; the next one starts from a clean slate.
  const returnToIdle = (): void => {
    noteIdRef.current = null;
    meetingStartedAtRef.current = null;
    expectedSpeakerCountRef.current = undefined;
    setNoteId(null);
    setTitle(null);
    setExpectedSpeakerCount(undefined);
    setMeetingStartedAt(null);
    setRawNotes('');
    lastSavedRawNotesRef.current = '';
    setPhase('idle');
  };

  const finish = async (onCaptureStopped: () => void): Promise<void> => {
    // Measured at Stop: transcription below can take minutes and must not count as missed time.
    const coverage = captureCoverage(
      recorderHealth.capturedMs,
      meetingStartedAtRef.current == null ? 0 : Date.now() - meetingStartedAtRef.current,
    );
    const noteId = noteIdRef.current;
    const expectedSpeakerCount = expectedSpeakerCountRef.current;
    setPhase('processing');
    try {
      const uri = await recording.stopRecordingRaw();
      onCaptureStopped();
      if (!uri || noteId == null) {
        saveRawNotesNow();
        if (noteId != null) markNoteFailed(noteId);
        returnToIdle();
        return;
      }
      saveRawNotesNow();
      const stableUri = `${FileSystem.documentDirectory}meeting-${noteId}.wav`;
      await FileSystem.copyAsync({ from: uri, to: stableUri });
      await excludeMeetingFileFromBackup(stableUri);
      // The recorder's own file is a second copy of the meeting that nothing else deletes.
      await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => undefined);
      await runMeetingPipeline(noteId, stableUri, expectedSpeakerCount, {
        fence: accountFenceRef.current ?? undefined,
      });
      returnToIdle();
      setFinishedNoteId(noteId);
      reportMeetingFinished({
        path: 'local',
        coverage,
        interruptions: localInterruptionsRef.current,
        reconnects: 0,
        droppedSeconds: 0,
      });
      alertIfPartialCapture(coverage);
    } catch (error) {
      if (noteId != null) markNoteFailed(noteId);
      Sentry.captureException(error);
      returnToIdle();
    }
  };

  const finishCloud = async (): Promise<void> => {
    // Read these before awaiting: the stop waits for the last turn and state moves on meanwhile.
    const captured = cloudMeeting.capturedSeconds;
    // From when capture began, not note creation: the first-run mic prompt and the connect
    // come in between and would read as missed meeting time.
    const elapsedMs = cloudMeeting.liveSinceMs == null ? 0 : Date.now() - cloudMeeting.liveSinceMs;
    const coverage = captureCoverage(
      (cloudMeeting.capturedSeconds - cloudMeeting.droppedSeconds) * 1000,
      elapsedMs,
    );
    const noteId = noteIdRef.current;
    const hadError = cloudMeeting.status === 'error';
    const { interruptions, reconnects, droppedSeconds } = cloudMeeting;
    setPhase('processing');
    const result = await cloudMeeting.stop();
    if (noteId == null) {
      returnToIdle();
      return;
    }
    saveRawNotesNow();
    // Linked before finalizing and before a failure: a failed note keeping its recording is
    // what Retry needs later.
    if (result.recordingUri) {
      notesRepository.updateNoteMeta(noteId, { sourceFile: result.recordingUri });
    }
    // A failed session with nothing transcribed and no recording shouldn't become a done,
    // empty note. With a recording the store tries the file and decides done or failed.
    if (hadError && result.utterances.length === 0 && !result.recordingUri) {
      markNoteFailed(noteId);
      returnToIdle();
      return;
    }
    try {
      const { owedMs, unsavedOwedMs = 0 } = await finalizeCloudMeeting(noteId, result, captured, {
        fence: accountFenceRef.current ?? undefined,
      });
      returnToIdle();
      setFinishedNoteId(noteId);
      reportMeetingFinished({
        path: 'cloud',
        coverage,
        interruptions,
        reconnects,
        droppedSeconds,
      });
      alertCloudMeetingCapture({
        elapsedMs,
        capturedMs: captured * 1000,
        // With a recording, audio the stream dropped is transcribed from the file (now, or
        // later when its list was saved), so nothing it recorded is missed.
        missedMs: result.recordingUri ? 0 : droppedSeconds * 1000,
        // Done, but part of the recording is still waiting to be transcribed: without this
        // the note would look complete until the stretches appear on their own later.
        owedMs,
        // Recorded, but its list of owed audio could not be saved, so it never will be.
        unsavedMs: unsavedOwedMs,
      });
    } catch (error) {
      markNoteFailed(noteId);
      // A fixed message and a code: the error itself can carry a file path.
      const code = (error as { code?: unknown } | null)?.code;
      Sentry.captureMessage('meeting-finalize-failed', {
        level: 'error',
        tags: {
          feature: 'meeting-post-pass',
          error_code: typeof code === 'string' ? code : 'unknown',
        },
      });
      returnToIdle();
    }
  };

  const endMeeting = async (): Promise<void> => {
    const active = phaseRef.current;
    if ((active !== 'recording' && active !== 'cloud-recording') || finishingRef.current) return;
    finishingRef.current = true;
    let markCaptured: () => void = () => undefined;
    const captured = new Promise<void>((resolve) => {
      markCaptured = resolve;
    });
    const done = (async (): Promise<void> => {
      try {
        // Saved before the stop awaits anything: the debounce is cancelled once processing starts.
        saveRawNotesNow();
        await (active === 'cloud-recording' ? finishCloud() : finish(markCaptured));
      } finally {
        // Also on failure, so a waiter on the capture never hangs.
        markCaptured();
        finishingRef.current = false;
        inFlightFinishRef.current = null;
      }
    })();
    if (finishingRef.current) {
      inFlightFinishRef.current = {
        path: active === 'cloud-recording' ? 'cloud' : 'local',
        captured,
        done,
      };
    }
    await done;
  };
  // Callers (the lock screen, a later screen, a sign-out) hold one identity across renders; it
  // must still finish with this render's values, as the screen's own handler did.
  const endMeetingRef = useRef(endMeeting);
  endMeetingRef.current = endMeeting;
  const stop = useCallback((): Promise<void> => endMeetingRef.current(), []);

  // Handed to non-React callers (sign-out, warm resume). Reads refs only, so it never goes stale.
  const stopSettled = useCallback(async (): Promise<void> => {
    if (startingRef.current) {
      await startPromiseRef.current?.catch(() => undefined);
    }
    if (inFlightFinishRef.current == null) endMeetingRef.current().catch(Sentry.captureException);
    const inFlight = inFlightFinishRef.current;
    if (inFlight == null) return;
    // A cloud finalise needs the session, so sign-out waits for all of it. On-device processing
    // can take minutes, so once capture has stopped it carries on alone. That is safe for the next
    // account: the pipeline holds the account it started under (accountFenceRef) and skips cloud
    // calls and voice-profile matching if the account changed; only on-device work continues.
    await (inFlight.path === 'local' ? inFlight.captured : inFlight.done);
  }, []);
  // Nothing is settled when the provider unmounts: it sits above everything, so that only happens
  // on dev Fast Refresh, and a real process death runs no clean-up at all. Launch recovery
  // (meetingRecovery.ts) owns a note left in "recording": it links the file and backfills the tail.
  useEffect(() => {
    registerActiveMeeting({
      isActive: () => phaseRef.current !== 'idle' || startingRef.current,
      stop: stopSettled,
    });
    return () => registerActiveMeeting(null);
  }, [stopSettled]);

  // A meeting belongs to the account that started it. Only a real change counts: not the first
  // sign-in at launch, and not a guest session starting (both are null before).
  const userId = useAuthStore((state) => state.user?.id ?? null);
  const previousUserIdRef = useRef(userId);
  useEffect(() => {
    const previous = previousUserIdRef.current;
    previousUserIdRef.current = userId;
    if (
      previous != null &&
      previous !== userId &&
      (phaseRef.current !== 'idle' || startingRef.current)
    ) {
      stopSettled().catch(Sentry.captureException);
    }
  }, [userId, stopSettled]);

  const acknowledgeFinished = useCallback((): void => setFinishedNoteId(null), []);

  const meetingActivityPhase: MeetingActivityPhase =
    phase === 'recording' || phase === 'cloud-recording'
      ? 'recording'
      : phase === 'processing'
        ? 'processing'
        : 'idle';
  useMeetingLiveActivity({
    phase: meetingActivityPhase,
    title,
    startedAt: meetingStartedAt,
    capturing,
    capturedSeconds,
    onEndRequested: () => {
      stop().catch(Sentry.captureException);
    },
  });

  useCapturePausedNotification(meetingActivityPhase === 'recording', capturing);

  const value: MeetingSession = {
    phase,
    path,
    noteId,
    title,
    expectedSpeakerCount,
    capturing,
    capturedSeconds,
    starting,
    cloud: {
      status: cloudMeeting.status,
      error: cloudMeeting.error,
      utterances: cloudMeeting.utterances,
      partialText: cloudMeeting.partialText,
      liveSinceMs: cloudMeeting.liveSinceMs,
    },
    rawNotes,
    setRawNotes,
    startLocal,
    startCloud,
    stop,
    finishedNoteId,
    acknowledgeFinished,
  };

  const liveMeetingNoteId = phase !== 'idle' ? noteId : null;

  return (
    <MeetingSessionContext.Provider value={value}>
      <LiveMeetingNoteContext.Provider value={liveMeetingNoteId}>
        {children}
      </LiveMeetingNoteContext.Provider>
    </MeetingSessionContext.Provider>
  );
}

/** The note the live meeting is recording, or null. Re-renders only when a meeting starts or ends. */
export function useLiveMeetingNoteId(): number | null {
  return useContext(LiveMeetingNoteContext);
}

export function useMeetingSession(): MeetingSession {
  const session = useContext(MeetingSessionContext);
  if (session == null) {
    throw new Error('useMeetingSession must be used inside a MeetingSessionProvider.');
  }
  return session;
}
