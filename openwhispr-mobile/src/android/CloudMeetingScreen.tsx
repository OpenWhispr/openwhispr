import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, PermissionsAndroid, View } from 'react-native';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { usePreventRemove } from '@react-navigation/native';
import { useTranslation } from 'react-i18next';
import { MeetingSetup } from './MeetingSetup';
import { createCloudMeetingContext } from './cloudMeetingContext';
import { useCloudMeeting, CloudMeetingFinishError } from './useCloudMeeting';
import { CloudMeetingRecording } from '@/components/notes/CloudMeetingRecording.android';
import { Text } from '@/components/ui/Text';
import { ProcessingWaveform } from '@/components/features/WaveformVisualizer';
import { BRAND } from '@/config/colors';
import { notesRepository } from '@/data';
import { useNotesStore } from '@/store/useNotesStore';
import { useAuthStore } from '@/store/useAuthStore';
import { useProcessingModeStore } from '@/store/useProcessingModeStore';
import { useSuperwallGate } from '@/hooks/useSuperwallGate';
import { SUPERWALL_PLACEMENTS } from '@/lib/superwall';
import { meetingAudioDirectory } from '@/lib/meetingAudioStorage';
import { canTransition } from '@/lib/diarization/transcriptionStatus';
import { getPreferredTranscriptionLanguage } from '@/lib/transcriptionLanguage';
import { Sentry } from '@/lib/sentry';
import type { TranscriptionStatus } from '@/types';

type Phase = 'prompt' | 'recording' | 'finalizing' | 'save-failed' | 'cancelling' | 'cancel-failed';
type Capture = {
  noteId: number;
  sourceFile: string;
  context: ReturnType<typeof createCloudMeetingContext>;
};

/** Android Cloud lifecycle only; the default screen continues to own Local and iOS. */
export function CloudMeetingScreen(): React.JSX.Element {
  const { t } = useTranslation('android');
  const params = useLocalSearchParams<{ folderId?: string; spaceId?: string }>();
  const [phase, setPhase] = useState<Phase>('prompt');
  const [starting, setStarting] = useState(false);
  const [noteId, setNoteId] = useState<number>();
  const [rawNotes, setRawNotes] = useState('');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [exitToNote, setExitToNote] = useState<number | null>(null);
  const focused = useRef(true);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const generation = useRef(0);
  const busy = useRef(false);
  const finishing = useRef(false);
  const capture = useRef<Capture | null>(null);
  const raw = useRef('');
  raw.current = rawNotes;
  const lastSaved = useRef('');
  const { register } = useSuperwallGate();
  const cloud = useCloudMeeting({
    enabled: phase === 'recording' || phase === 'finalizing' || phase === 'save-failed',
    language: getPreferredTranscriptionLanguage(),
    noteId,
  });
  const {
    cancel: cancelCloud,
    stop: stopCloud,
    elapsedSeconds: cloudElapsed,
    status: cloudStatus,
  } = cloud;
  const markFailed = useCallback((id: number) => {
    const status = notesRepository.getNoteById(id)?.transcriptionStatus;
    if (status != null && canTransition(status as TranscriptionStatus, 'failed'))
      useNotesStore.getState().transitionStatus(id, 'failed');
  }, []);
  const saveRaw = useCallback((run: Capture) => {
    if (capture.current !== run || !run.context.ownsNote() || raw.current === lastSaved.current)
      return;
    useNotesStore.getState().updateNote(run.noteId, { content: raw.current });
    lastSaved.current = raw.current;
  }, []);

  const cancel = useCallback(
    async (run: Capture | null, leave = false): Promise<void> => {
      if (!run || capture.current !== run) return;
      let draftError: unknown;
      try {
        saveRaw(run);
      } catch (error) {
        draftError = error;
      }
      capture.current = null;
      const request = generation.current;
      if (mounted.current) setPhase('cancelling');
      try {
        await cancelCloud();
        if (draftError) throw draftError;
        const ownsSaved = run.context.ownsSavedNote();
        if (ownsSaved) markFailed(run.noteId);
        else
          run.context.recoverInterruptedNoteWhenOwnerReturns(run.sourceFile, () =>
            markFailed(run.noteId),
          );
        if (mounted.current && !capture.current) {
          setPhase('prompt');
          if (leave && focused.current && ownsSaved && generation.current === request)
            setExitToNote(run.noteId);
        }
        run.context.dispose();
      } catch (error) {
        Sentry.captureException(error);
        if (mounted.current && !capture.current && run.context.ownsSavedNote()) {
          capture.current = run;
          setPhase('cancel-failed');
        } else {
          run.context.recoverInterruptedNoteWhenOwnerReturns(run.sourceFile, () =>
            markFailed(run.noteId),
          );
          run.context.dispose();
          if (mounted.current && !capture.current) {
            setRawNotes('');
            setPhase('prompt');
          }
        }
      }
    },
    [cancelCloud, markFailed, saveRaw],
  );
  const invalidate = useCallback(() => {
    generation.current += 1;
    busy.current = false;
    cancel(capture.current).catch(Sentry.captureException);
    if (mounted.current) setStarting(false);
  }, [cancel]);
  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      return () => {
        focused.current = false;
        invalidate();
      };
    }, [invalidate]),
  );
  useEffect(() => {
    const auth = useAuthStore.subscribe((state, previous) => {
      if (state.user?.id !== previous.user?.id || state.sessionCookie !== previous.sessionCookie)
        invalidate();
    });
    const mode = useProcessingModeStore.subscribe((state, previous) => {
      if (state.activeMode !== previous.activeMode) invalidate();
    });
    return () => {
      auth();
      mode();
    };
  }, [invalidate]);
  useEffect(invalidate, [params.folderId, params.spaceId, invalidate]);
  useEffect(() => {
    const run = capture.current;
    if (phase !== 'recording' || !run) return;
    const timer = setTimeout(() => saveRaw(run), 800);
    return () => clearTimeout(timer);
  }, [rawNotes, phase, saveRaw]);

  const begin = async () => {
    if (!focused.current || busy.current || capture.current || phase !== 'prompt') return;
    busy.current = true;
    setStarting(true);
    const request = ++generation.current;
    const identity = useAuthStore.getState();
    const mode = useProcessingModeStore.getState().activeMode;
    const current = () =>
      focused.current &&
      generation.current === request &&
      useAuthStore.getState().user?.id === identity.user?.id &&
      useAuthStore.getState().sessionCookie === identity.sessionCookie &&
      useProcessingModeStore.getState().activeMode === mode;
    let launched = false;
    try {
      const granted = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO);
      if (!current()) return;
      if (granted !== PermissionsAndroid.RESULTS.GRANTED) {
        Alert.alert(t('errorTitle'), t('permissionDenied'));
        return;
      }
      await register({
        placement: SUPERWALL_PLACEMENTS.meetingRecordStart,
        params: { expectedSpeakerCount: 0 },
        requiresAccount: false,
        feature: () => {
          if (!current() || launched) return;
          launched = true;
          let created: number | undefined;
          try {
            const directory = meetingAudioDirectory();
            if (!directory) throw new Error('Meeting audio storage is unavailable.');
            const note = useNotesStore.getState().createMeetingNote({
              folderId: params.folderId ? Number(params.folderId) : undefined,
              spaceId: params.spaceId ? Number(params.spaceId) : undefined,
              diarizationEnabled: false,
            });
            created = note.id;
            const sourceFile = `${directory}meeting-${note.id}.wav`;
            notesRepository.updateNoteMeta(note.id, { sourceFile });
            const context = createCloudMeetingContext(note.id);
            const run = { noteId: note.id, sourceFile, context };
            capture.current = run;
            context.signal.addEventListener(
              'abort',
              () => {
                cancel(run).catch(Sentry.captureException);
              },
              { once: true },
            );
            lastSaved.current = note.content;
            setRawNotes(note.content);
            setNoteId(note.id);
            finishing.current = false;
            setSaveError(null);
            setPhase('recording');
          } catch (error) {
            if (created != null && current()) markFailed(created);
            Sentry.captureException(error);
            if (current()) Alert.alert(t('errorTitle'), t('meetingInterrupted'));
          }
        },
      });
    } catch (error) {
      Sentry.captureException(error);
      if (current()) Alert.alert(t('errorTitle'), t('meetingInterrupted'));
    } finally {
      if (current()) {
        busy.current = false;
        setStarting(false);
      }
    }
  };

  const finish = useCallback(async (): Promise<void> => {
    const run = capture.current;
    const current = () => run != null && capture.current === run && run.context.ownsNote();
    if (!run || !current() || finishing.current) return;
    finishing.current = true;
    setPhase('finalizing');
    setSaveError(null);
    let utterances;
    let interrupted: Error | null = null;
    try {
      utterances = await stopCloud();
    } catch (error) {
      interrupted = error instanceof Error ? error : new Error(String(error));
      utterances = error instanceof CloudMeetingFinishError ? error.utterances : [];
    }
    if (!current()) return;
    try {
      saveRaw(run);
      await useNotesStore.getState().finalizeCloudMeeting(run.noteId, utterances, cloudElapsed, {
        incomplete: interrupted !== null || cloudStatus === 'error',
      });
    } catch (error) {
      if (!current()) return;
      Sentry.captureException(error);
      setSaveError(t('meetingSaveFailedBody'));
      setPhase('save-failed');
      finishing.current = false;
      return;
    }
    if (!current()) return;
    capture.current = null;
    run.context.dispose();
    if (interrupted) Alert.alert(t('meetingInterrupted'), interrupted.message);
    setPhase('prompt');
    setExitToNote(run.noteId);
  }, [stopCloud, cloudElapsed, cloudStatus, saveRaw, t]);
  useEffect(() => {
    if (cloud.stopRequested && phase === 'recording') finish().catch(Sentry.captureException);
  }, [cloud.stopRequested, phase, finish]);
  useEffect(() => {
    if (exitToNote != null && phase === 'prompt') router.replace(`/(tabs)/(notes)/${exitToNote}`);
  }, [exitToNote, phase]);
  usePreventRemove(phase !== 'prompt', () => {
    if (phase === 'finalizing' || phase === 'cancelling') return;
    if (phase === 'cancel-failed') {
      cancel(capture.current, true).catch(Sentry.captureException);
      return;
    }
    const run = capture.current;
    Alert.alert(
      t(phase === 'save-failed' ? 'meetingSaveFailedTitle' : 'meetingLeaveTitle'),
      t(phase === 'save-failed' ? 'meetingSaveFailedBody' : 'meetingLeaveBody'),
      [
        { text: t('meetingKeepRecording'), style: 'cancel' },
        {
          text: t(phase === 'save-failed' ? 'retry' : 'meetingStopSave'),
          onPress: () => {
            if (run && capture.current === run) finish().catch(Sentry.captureException);
          },
        },
        {
          text: t(phase === 'save-failed' ? 'meetingDiscardUnsaved' : 'cancel'),
          onPress: () => {
            cancel(run, true).catch(Sentry.captureException);
          },
        },
      ],
    );
  });
  if (phase === 'prompt')
    return (
      <MeetingSetup
        busy={starting}
        onStart={() => {
          begin().catch(Sentry.captureException);
        }}
      />
    );
  if (phase === 'recording' || phase === 'save-failed' || phase === 'cancel-failed')
    return (
      <CloudMeetingRecording
        status={saveError || phase === 'cancel-failed' ? 'error' : cloud.status}
        error={phase === 'cancel-failed' ? t('meetingSaveFailedBody') : (saveError ?? cloud.error)}
        stopLabel={phase === 'save-failed' || phase === 'cancel-failed' ? t('retry') : undefined}
        elapsedSeconds={cloud.elapsedSeconds}
        rawNotes={rawNotes}
        onChangeRawNotes={setRawNotes}
        utterances={cloud.utterances}
        partialText={cloud.partialText}
        onStop={() => {
          if (phase === 'cancel-failed')
            cancel(capture.current, true).catch(Sentry.captureException);
          else finish().catch(Sentry.captureException);
        }}
      />
    );
  return (
    <View className="flex-1 items-center justify-center gap-7 bg-systemBackground px-6">
      <ProcessingWaveform color={BRAND} size={48} />
      <Text>{t(phase === 'cancelling' ? 'meetingSaveForLater' : 'meetingFinishing')}</Text>
    </View>
  );
}
