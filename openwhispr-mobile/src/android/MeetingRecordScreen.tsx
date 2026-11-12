import { useMeetingCalendar } from '@/hooks/useMeetingCalendar';
import { useMeetingElapsedTime } from '@/hooks/useMeetingElapsedTime';
import { useMeetingDraft } from '@/hooks/useMeetingDraft';
import { LocalMeetingRecording } from '@/components/notes/LocalMeetingRecording.android';
import { useTranslation } from 'react-i18next';
import { useCallback, useEffect, useRef, useState } from 'react';
import type React from 'react';
import { Alert, View, PermissionsAndroid } from 'react-native';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { usePreventRemove } from '@react-navigation/native';
import { useHeaderHeight } from '@react-navigation/elements';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as FileSystem from 'expo-file-system/legacy';
import { Text } from '@/components/ui/Text';
import { Button } from '@/components/ui/Button';
import { ProcessingWaveform } from '@/components/features/WaveformVisualizer';
import { BRAND } from '@/config/colors';
import { notesRepository } from '@/data';
import type { Note } from '@/data/types';
import { useAudioRecording } from '@/hooks/useAudioRecording';
import { useKeyboardHeight } from '@/hooks/useKeyboardHeight';
import { getPreferredTranscriptionLanguage } from '@/lib/transcriptionLanguage';
import { useSuperwallGate } from '@/hooks/useSuperwallGate';
import { useNotesStore } from '@/store/useNotesStore';
import { useAuthStore } from '@/store/useAuthStore';
import { canRunCloudMeeting } from '@/lib/accountAccess';
import { useProcessingModeStore } from '@/store/useProcessingModeStore';
import { CloudMeetingFinishError, useCloudMeeting } from '@/hooks/useCloudMeeting.android';
import { useMeetingLiveActivity, type MeetingActivityPhase } from '@/hooks/useMeetingLiveActivity';
import { CloudMeetingRecording } from '@/components/notes/CloudMeetingRecording.android';
import { canTransition } from '@/lib/diarization/transcriptionStatus';
import { MeetingSetup } from '@/android/MeetingSetup';
import { LocalMeetingRecorder } from '@/android/LocalMeetingRecorder';
import { createLocalMeetingContext } from '@/android/localMeetingContext';
import { Sentry } from '@/lib/sentry';
import { SUPERWALL_PLACEMENTS } from '@/lib/superwall';
import type { TranscriptionStatus } from '@/types';
type Phase =
  | 'prompt'
  | 'unsupported'
  | 'needs-model'
  | 'downloading'
  | 'recording'
  | 'cloud-finalizing'
  | 'cloud-recording'
  | 'cloud-save-failed'
  | 'processing';
type LocalCapture = {
  recorder: LocalMeetingRecorder;
  context: ReturnType<typeof createLocalMeetingContext>;
  controller: AbortController;
  noteId: number;
  expected: number | undefined;
  finishing: boolean;
};
export const MeetingRecordScreen = (): React.JSX.Element => {
  const { t } = useTranslation('android');
  const [cloudSaveError, setCloudSaveError] = useState<string | null>(null);
  const [exitToNote, setExitToNote] = useState<number | null>(null);
  const finishingRef = useRef(false);
  const [starting, setStarting] = useState(false);
  const focused = useRef(true);
  const requestGeneration = useRef(0);
  const requestBusy = useRef(false);
  const preparingLocalRecording = useRef(false);
  const localCapture = useRef<LocalCapture | null>(null);
  const cancelLocalCapture = useRef<() => void>(() => undefined);
  const finishLocalCapture = useRef<(error?: Error) => Promise<void>>(async () => undefined);
  const resumeAfterDownload = useRef<(() => Promise<void>) | null>(null);
  const [phase, setPhase] = useState<Phase>('prompt');
  const [noteId, setNoteId] = useState<number | null>(null);
  const [count, setCount] = useState<number | undefined>(undefined);
  // Wall-clock start of the current meeting (local or cloud), for the Live Activity timer.
  // recordingStartedAtRef is local-only and is cleared as soon as processing starts.
  const [meetingStartedAt, setMeetingStartedAt] = useState<number | null>(null);
  const headerHeight = useHeaderHeight();
  const insets = useSafeAreaInsets();
  // Only the recording phase has a notes field to keep above the keyboard.
  const keyboardHeight = useKeyboardHeight(phase === 'recording');
  const createMeetingNote = useNotesStore((s) => s.createMeetingNote);
  const transitionStatus = useNotesStore((s) => s.transitionStatus);
  const runMeetingPipeline = useNotesStore((s) => s.runMeetingPipeline);
  const finalizeCloudMeeting = useNotesStore((s) => s.finalizeCloudMeeting);
  const isDiarizerAvailable = useNotesStore((s) => s.isDiarizerAvailable);
  const isDiarizerModelReady = useNotesStore((s) => s.isDiarizerModelReady);
  const isLocalAsrModelReady = useNotesStore((s) => s.isLocalAsrModelReady);
  const downloadDiarizerModel = useNotesStore((s) => s.downloadDiarizerModel);
  const { register: registerSuperwallGate } = useSuperwallGate();
  // Where the meeting was started from; createMeetingNote files it there when it still can.
  const params = useLocalSearchParams<{
    folderId?: string;
    spaceId?: string;
  }>();
  const startedIn = {
    folderId: params.folderId ? Number(params.folderId) : undefined,
    spaceId: params.spaceId ? Number(params.spaceId) : undefined,
  };
  useAudioRecording({ allowsBackgroundRecording: true, onError: () => setPhase('prompt') });
  const cloudMeeting = useCloudMeeting({
    enabled:
      phase === 'cloud-recording' || phase === 'cloud-finalizing' || phase === 'cloud-save-failed',
    noteId: noteId ?? undefined,
    language: getPreferredTranscriptionLanguage(),
  });
  const { selectedMeetingContext } = useMeetingCalendar(phase);
  const startContext = JSON.stringify({
    ...startedIn,
    meeting: selectedMeetingContext,
  });
  const latestStartContext = useRef(startContext);
  latestStartContext.current = startContext;
  const invalidateStart = useCallback(() => {
    requestGeneration.current += 1;
    requestBusy.current = false;
    resumeAfterDownload.current = null;
    cancelLocalCapture.current();
    if (focused.current) setStarting(false);
  }, []);
  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      return () => {
        focused.current = false;
        invalidateStart();
      };
    }, [invalidateStart]),
  );
  useEffect(() => {
    const unsubscribeAccount = useAuthStore.subscribe((state, previous) => {
      if (state.user?.id !== previous.user?.id || state.sessionCookie !== previous.sessionCookie)
        invalidateStart();
    });
    const unsubscribeMode = useProcessingModeStore.subscribe((state, previous) => {
      if (state.activeMode !== previous.activeMode) invalidateStart();
    });
    return () => {
      unsubscribeAccount();
      unsubscribeMode();
    };
  }, [invalidateStart]);
  useEffect(invalidateStart, [startContext, invalidateStart]);
  const { elapsedSeconds, recordingStartedAtRef } = useMeetingElapsedTime(phase);
  const canWriteDraft = useCallback(
    (draftPhase: string) =>
      (draftPhase !== 'recording' && draftPhase !== 'processing') ||
      !!localCapture.current?.context.ownsNote(),
    [],
  );
  const { rawNotes, setRawNotes, lastSavedRawNotesRef, saveRawNotesNow } = useMeetingDraft(
    phase,
    noteId,
    canWriteDraft,
  );

  // Mark an in-flight note failed when we abandon a recording (guarded: skip if already terminal,
  // since processMeeting may have set 'failed' directly).
  const markNoteFailed = useCallback(
    (id: number): void => {
      const status = notesRepository.getNoteById(id)?.transcriptionStatus;
      if (status != null && canTransition(status as TranscriptionStatus, 'failed')) {
        transitionStatus(id, 'failed');
      }
    },
    [transitionStatus],
  );
  cancelLocalCapture.current = () => {
    const run = localCapture.current;
    if (!run) return;
    localCapture.current = null;
    run.controller.abort();
    const stopped = run.recorder.stop().catch(Sentry.captureException);
    try {
      if (run.context.ownsSavedNote()) markNoteFailed(run.noteId);
      else
        stopped
          .then(() =>
            run.context.recoverInterruptedNoteWhenOwnerReturns(run.recorder.uri, () =>
              markNoteFailed(run.noteId),
            ),
          )
          .catch(Sentry.captureException);
    } catch (error) {
      Sentry.captureException(error);
    } finally {
      run.context.dispose();
    }
    if (focused.current) setPhase('prompt');
  };
  const startAndroidLocalRecording = async (
    expected: number | undefined,
    isCurrent: () => boolean,
  ) => {
    if (!isCurrent() || preparingLocalRecording.current || localCapture.current) return;
    preparingLocalRecording.current = true;
    setStarting(true);
    let run: LocalCapture | null = null;
    let createdNoteId: number | null = null;
    try {
      const permission = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
      );
      if (!isCurrent()) return;
      if (permission !== PermissionsAndroid.RESULTS.GRANTED) {
        Alert.alert(t('errorTitle'), t('permissionDenied'));
        return;
      }
      // Native capture needs the durable note ID, but denial must not create a note.
      const note = createMeetingNote({
        ...startedIn,
        expectedSpeakerCount: expected,
        calendarEventId: selectedMeetingContext?.calendarEventId ?? null,
        title: selectedMeetingContext?.title ?? null,
        participants: selectedMeetingContext?.participants ?? null,
      });
      createdNoteId = note.id;
      const controller = new AbortController();
      const recorder = new LocalMeetingRecorder(note.id, (error) => {
        if (localCapture.current === run)
          finishLocalCapture.current(error).catch(Sentry.captureException);
      });
      const context = createLocalMeetingContext(note.id, controller.signal);
      run = {
        recorder,
        context,
        controller,
        noteId: note.id,
        expected,
        finishing: false,
      };
      localCapture.current = run;
      notesRepository.updateNoteMeta(note.id, {
        sourceFile: recorder.uri,
      });
      context.signal.addEventListener(
        'abort',
        () => {
          if (localCapture.current === run) cancelLocalCapture.current();
        },
        {
          once: true,
        },
      );
      await recorder.start();
      if (!isCurrent() || localCapture.current !== run) {
        if (localCapture.current === run) cancelLocalCapture.current();
        return;
      }
      context.checkpoint();
      setRawNotes(note.content);
      lastSavedRawNotesRef.current = note.content;
      setNoteId(note.id);
      const startedAt = Date.now();
      recordingStartedAtRef.current = startedAt;
      setMeetingStartedAt(startedAt);
      setPhase('recording');
    } catch (error) {
      if (run && localCapture.current === run) cancelLocalCapture.current();
      if (!run && createdNoteId != null && isCurrent()) markNoteFailed(createdNoteId);
      if (isCurrent()) {
        setPhase('prompt');
        Alert.alert(
          t('errorTitle'),
          error instanceof Error ? error.message : t('meetingInterrupted'),
        );
      }
      Sentry.captureException(error);
    } finally {
      preparingLocalRecording.current = false;
      if (isCurrent()) setStarting(false);
    }
  };

  const startRecording = startAndroidLocalRecording;
  const begin = async (expected: number | undefined): Promise<void> => {
    if (
      !focused.current ||
      requestBusy.current ||
      preparingLocalRecording.current ||
      localCapture.current
    )
      return;
    const requestId = ++requestGeneration.current;
    const ownerId = useAuthStore.getState().user?.id;
    const mode = useProcessingModeStore.getState().activeMode;
    const context = latestStartContext.current;
    const isCurrent = () =>
      focused.current &&
      requestId === requestGeneration.current &&
      ownerId === useAuthStore.getState().user?.id &&
      mode === useProcessingModeStore.getState().activeMode &&
      context === latestStartContext.current;
    const cloud = isCloudMeeting();
    let launched = false;
    const authorize = async () => {
      if (!isCurrent()) return;
      await registerSuperwallGate({
        placement: SUPERWALL_PLACEMENTS.meetingRecordStart,
        params: {
          expectedSpeakerCount: expected ?? 0,
        },
        requiresAccount: false,
        feature: () => {
          if (!isCurrent() || launched) return;
          launched = true;
          if (cloud) startCloudMeeting(expected);
          else void startRecording(expected, isCurrent).catch(Sentry.captureException);
        },
      });
    };
    requestBusy.current = true;
    setStarting(true);
    setCount(expected);
    try {
      if (cloud) {
        let granted = false;
        try {
          granted =
            (await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO)) ===
            PermissionsAndroid.RESULTS.GRANTED;
        } catch (error) {
          Sentry.captureException(error);
        }
        if (!isCurrent()) return;
        if (!granted) {
          Alert.alert(t('errorTitle'), t('permissionDenied'));
          return;
        }
        await authorize();
        return;
      }
      const supported = await isDiarizerAvailable();
      if (!isCurrent()) return;
      if (!supported) {
        setPhase('unsupported');
        return;
      }
      const speechReady = await isLocalAsrModelReady();
      if (!isCurrent()) return;
      if (!speechReady) {
        Alert.alert(t('speechModels'), t('meetingSpeechNeeded'));
        setPhase('prompt');
        return;
      }
      const diarizerReady = await isDiarizerModelReady();
      if (!isCurrent()) return;
      if (!diarizerReady) {
        resumeAfterDownload.current = authorize;
        setPhase('needs-model');
        return;
      }
      await authorize();
    } finally {
      if (requestId === requestGeneration.current) {
        requestBusy.current = false;
        if (focused.current && !preparingLocalRecording.current) setStarting(false);
      }
    }
  };
  const confirmDownload = async (): Promise<void> => {
    const resume = resumeAfterDownload.current;
    const requestId = requestGeneration.current;
    if (!resume || !focused.current) return;
    setPhase('downloading');
    try {
      await downloadDiarizerModel();
      await resume();
    } catch (error) {
      Sentry.captureException(error);
      if (focused.current && requestId === requestGeneration.current) setPhase('prompt');
    }
  };
  finishLocalCapture.current = async (interrupted?: Error) => {
    const run = localCapture.current;
    if (!run || run.finishing) return;
    run.finishing = true;
    setPhase('processing');
    try {
      const uri = await run.recorder.stop();
      run.context.checkpoint();
      saveRawNotesNow();
      if (interrupted) throw interrupted;
      await runMeetingPipeline(run.noteId, uri, run.expected, {
        signal: run.controller.signal,
      });
      run.context.checkpoint();
      if (localCapture.current === run && focused.current) {
        setPhase('prompt');
        setExitToNote(run.noteId);
      }
    } catch (error) {
      if (run.context.ownsNote()) markNoteFailed(run.noteId);
      if (localCapture.current === run && focused.current) {
        setPhase('prompt');
        setExitToNote(run.noteId);
        if (error instanceof Error && error.name !== 'AbortError')
          Alert.alert(t('meetingInterrupted'), error.message);
      }
      if (!(error instanceof Error && error.name === 'AbortError')) Sentry.captureException(error);
    } finally {
      if (localCapture.current === run) localCapture.current = null;
      run.context.dispose();
    }
  };
  const finish = async (): Promise<void> => finishLocalCapture.current();
  const isCloudMeeting = (): boolean =>
    canRunCloudMeeting(useAuthStore.getState().user, useProcessingModeStore.getState().activeMode);

  // Android checks microphone access before authorization so denial leaves setup intact.
  // The realtime session checks again when capture starts. Once permitted, create the note
  // up front for live captions; a connection failure remains recoverable through finishCloud.
  const startCloudMeeting = (expected: number | undefined): void => {
    let note: Note;
    try {
      note = createMeetingNote({
        ...startedIn,
        expectedSpeakerCount: expected,
        calendarEventId: selectedMeetingContext?.calendarEventId ?? null,
        title: selectedMeetingContext?.title ?? null,
        participants: selectedMeetingContext?.participants ?? null,
        diarizationEnabled: false, // cloud realtime returns a flat transcript (no speakers)
      });
    } catch (error) {
      Sentry.captureException(error, {
        tags: {
          feature: 'meeting-calendar-context',
          calendar_context_operation: 'create_cloud_meeting_note',
          calendar_context_selected: !!selectedMeetingContext,
        },
      });
      setPhase('prompt');
      return;
    }
    setRawNotes(note.content);
    lastSavedRawNotesRef.current = note.content;
    setNoteId(note.id);
    setMeetingStartedAt(Date.now());
    notesRepository.updateNoteMeta(note.id, {
      sourceFile: `${FileSystem.documentDirectory}meeting-${note.id}.wav`,
    });
    finishingRef.current = false;
    setPhase('cloud-recording');
  };
  const { stop: stopCloud, elapsedSeconds: cloudElapsed, status: cloudStatus } = cloudMeeting;
  const finishCloud = useCallback(async (): Promise<void> => {
    if (finishingRef.current) return;
    finishingRef.current = true;
    setPhase('cloud-finalizing');
    setCloudSaveError(null);
    let utterances;
    let interrupted: Error | null = null;
    try {
      utterances = await stopCloud();
    } catch (error) {
      interrupted = error instanceof Error ? error : new Error(String(error));
      utterances = error instanceof CloudMeetingFinishError ? error.utterances : [];
    }
    try {
      if (noteId == null) throw new Error('Meeting note is unavailable.');
      saveRawNotesNow();
      await finalizeCloudMeeting(noteId, utterances, cloudElapsed, {
        incomplete: interrupted !== null || cloudStatus === 'error',
      });
    } catch (error) {
      // stopCloud retains its settled result, including partial text. Keep this
      // screen mounted so Retry can persist it without starting another recording.
      Sentry.captureException(error);
      setCloudSaveError(t('meetingSaveFailedBody'));
      setPhase('cloud-save-failed');
      finishingRef.current = false;
      return;
    }
    if (interrupted) Alert.alert(t('meetingInterrupted'), interrupted.message);
    setPhase('prompt');
    setExitToNote(noteId);
  }, [stopCloud, cloudElapsed, cloudStatus, finalizeCloudMeeting, noteId, saveRawNotesNow, t]);
  useEffect(() => {
    if (cloudMeeting.stopRequested && phase === 'cloud-recording') void finishCloud();
  }, [cloudMeeting.stopRequested, phase, finishCloud]);
  useEffect(() => {
    if (exitToNote != null && phase === 'prompt') router.replace(`/(tabs)/(notes)/${exitToNote}`);
  }, [exitToNote, phase]);
  usePreventRemove(
    phase === 'cloud-save-failed' ||
      phase === 'cloud-recording' ||
      phase === 'cloud-finalizing' ||
      phase === 'recording' ||
      phase === 'processing',
    () => {
      if (phase === 'processing') {
        Alert.alert(t('meetingInterrupted'), t('meetingCancelProcessingBody'), [
          {
            text: t('cancel'),
            style: 'cancel',
          },
          {
            text: t('meetingSaveForLater'),
            onPress: () => {
              const id = localCapture.current?.noteId;
              cancelLocalCapture.current();
              if (id != null) setExitToNote(id);
            },
          },
        ]);
        return;
      }
      if (phase === 'recording') {
        Alert.alert(t('meetingLeaveTitle'), t('meetingLeaveBody'), [
          {
            text: t('meetingKeepRecording'),
            style: 'cancel',
          },
          {
            text: t('meetingStopSave'),
            onPress: () => {
              finishLocalCapture.current().catch(Sentry.captureException);
            },
          },
        ]);
        return;
      }
      if (phase === 'cloud-finalizing') return;
      if (phase === 'cloud-save-failed') {
        Alert.alert(t('meetingSaveFailedTitle'), t('meetingSaveFailedBody'), [
          {
            text: t('cancel'),
            style: 'cancel',
          },
          {
            text: t('retry'),
            onPress: () => {
              void finishCloud();
            },
          },
          {
            text: t('meetingDiscardUnsaved'),
            style: 'destructive',
            onPress: () => {
              setPhase('prompt');
              setExitToNote(noteId);
            },
          },
        ]);
        return;
      }
      Alert.alert(t('meetingLeaveTitle'), t('meetingLeaveBody'), [
        {
          text: t('meetingKeepRecording'),
          style: 'cancel',
        },
        {
          text: t('meetingStopSave'),
          onPress: () => {
            void finishCloud();
          },
        },
        {
          text: t('cancel'),
          onPress: () => {
            cloudMeeting.cancel();
            saveRawNotesNow();
            if (noteId != null) markNoteFailed(noteId);
            setPhase('prompt');
            setExitToNote(noteId);
          },
        },
      ]);
    },
  );
  const meetingActivityPhase: MeetingActivityPhase =
    phase === 'recording' || phase === 'cloud-recording'
      ? 'recording'
      : phase === 'processing' || phase === 'cloud-finalizing'
        ? 'processing'
        : 'idle';
  useMeetingLiveActivity({
    phase: meetingActivityPhase,
    title: selectedMeetingContext?.title ?? null,
    startedAt: meetingStartedAt,
    onEndRequested: () => {
      if (phase !== 'recording' && phase !== 'cloud-recording') return;
      const stop = phase === 'cloud-recording' ? finishCloud : finish;
      stop().catch(Sentry.captureException);
    },
  });
  if (phase === 'prompt') {
    return (
      <MeetingSetup
        busy={starting}
        onStart={() => {
          if (starting) return;
          void begin(undefined).catch((error) => {
            if (focused.current) Alert.alert('Meeting', error.message);
          });
        }}
      />
    );
  }
  if (phase === 'unsupported') {
    return (
      <View
        className="flex-1 gap-4 bg-systemBackground px-6"
        style={{
          paddingTop: headerHeight,
        }}
      >
        <Text accessibilityRole="header" className="text-2xl font-bold text-label">
          Not available on this device
        </Text>
        <Text className="text-base text-secondaryLabel">{t('meetingPrivateBody')}</Text>
        <Button variant="secondary" onPress={() => router.back()}>
          Go back
        </Button>
      </View>
    );
  }
  if (phase === 'needs-model') {
    return (
      <View
        className="flex-1 gap-4 bg-systemBackground px-6"
        style={{
          paddingTop: headerHeight,
        }}
      >
        <Text accessibilityRole="header" className="text-2xl font-bold text-label">
          {t('meetingSpeakerModels')}
        </Text>
        <Text className="text-base text-secondaryLabel">{t('meetingDownloadBody')}</Text>
        <Button
          testID="model-download"
          onPress={() => {
            confirmDownload().catch(Sentry.captureException);
          }}
        >
          Download
        </Button>
        <Button
          testID="model-cancel"
          variant="secondary"
          onPress={() => {
            invalidateStart();
            setPhase('prompt');
          }}
        >
          Cancel
        </Button>
      </View>
    );
  }
  if (phase === 'recording') {
    return (
      <LocalMeetingRecording
        count={count}
        elapsedSeconds={elapsedSeconds}
        keyboardHeight={keyboardHeight}
        bottomInset={insets.bottom}
        headerHeight={headerHeight}
        rawNotes={rawNotes}
        setRawNotes={setRawNotes}
        onStop={finish}
      />
    );
  }
  if (phase === 'cloud-recording' || phase === 'cloud-save-failed') {
    return (
      <CloudMeetingRecording
        status={cloudSaveError ? 'error' : cloudMeeting.status}
        error={cloudSaveError ?? cloudMeeting.error}
        stopLabel={phase === 'cloud-save-failed' ? t('retry') : undefined}
        elapsedSeconds={cloudMeeting.elapsedSeconds}
        rawNotes={rawNotes}
        onChangeRawNotes={setRawNotes}
        utterances={cloudMeeting.utterances}
        partialText={cloudMeeting.partialText}
        onStop={() => {
          finishCloud().catch(Sentry.captureException);
        }}
      />
    );
  }

  // phase === 'processing' | 'downloading'
  return (
    <View className="flex-1 items-center justify-center gap-7 bg-systemBackground px-6">
      <ProcessingWaveform color={BRAND} size={48} />
      <View className="items-center gap-1.5">
        <Text className="text-lg font-semibold text-label">
          {phase === 'cloud-finalizing'
            ? t('meetingFinishing')
            : phase === 'downloading'
              ? 'Downloading model…'
              : 'Preparing meeting notes…'}
        </Text>
        <Text className="text-[13px] text-tertiaryLabel">
          {phase === 'cloud-finalizing'
            ? t('meetingFinishingBody')
            : phase === 'downloading'
              ? t('meetingDownloadBody')
              : 'Transcribing · separating voices · finalizing note'}
        </Text>
      </View>
      {phase === 'downloading' && (
        <Button
          testID="model-download-cancel"
          variant="secondary"
          onPress={() => {
            invalidateStart();
            setPhase('prompt');
            const { cancelAndroidDownload } =
              require('@/android/models') as typeof import('@/android/models');
            cancelAndroidDownload('meeting-speakers').catch(Sentry.captureException);
          }}
        >
          {t('cancel')}
        </Button>
      )}
    </View>
  );
};
