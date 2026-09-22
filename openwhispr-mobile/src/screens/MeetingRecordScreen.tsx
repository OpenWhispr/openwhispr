import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';
import { Alert, KeyboardAvoidingView, Platform, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { useHeaderHeight } from '@react-navigation/elements';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as FileSystem from 'expo-file-system/legacy';
import { Text } from '@/components/ui/Text';
import { Button } from '@/components/ui/Button';
import { ProcessingWaveform } from '@/components/features/WaveformVisualizer';
import { CalendarEventPicker } from '@/components/notes/CalendarEventPicker';
import { SpeakerCountPrompt } from '@/components/notes/SpeakerCountPrompt';
import { BRAND, iosColor } from '@/config/colors';
import { calendarRepository } from '@/data/calendarRepository';
import type { Note } from '@/data/types';
import type { GoogleCalendarEvent } from '@/data/calendarTypes';
import { useAudioRecording } from '@/hooks/useAudioRecording';
import { buildCalendarMeetingContext } from '@/lib/calendar/meetingContext';
import { getMeetingCalendarEventSuggestions } from '@/lib/calendar/meetingSuggestions';
import { getPreferredTranscriptionLanguage } from '@/lib/transcriptionLanguage';
import { useGoogleCalendarStore } from '@/store/useGoogleCalendarStore';
import { useSuperwallGate } from '@/hooks/useSuperwallGate';
import { useNotesStore } from '@/store/useNotesStore';
import { useAuthStore } from '@/store/useAuthStore';
import { canRunCloudMeeting } from '@/lib/accountAccess';
import { useProcessingModeStore } from '@/store/useProcessingModeStore';
import { useCloudMeeting } from '@/hooks/useCloudMeeting';
import { CloudMeetingRecording } from '@/components/notes/CloudMeetingRecording';
import { canTransition } from '@/lib/diarization/transcriptionStatus';
import { Sentry } from '@/lib/sentry';
import { SUPERWALL_PLACEMENTS } from '@/lib/superwall';
import type { TranscriptionStatus } from '@/types';

type Phase =
  | 'prompt'
  | 'unsupported'
  | 'needs-model'
  | 'downloading'
  | 'recording'
  | 'cloud-recording'
  | 'processing';

const formatClock = (seconds: number): string =>
  `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;

export const MeetingRecordScreen = (): React.JSX.Element => {
  const [phase, setPhase] = useState<Phase>('prompt');
  const [noteId, setNoteId] = useState<number | null>(null);
  const [count, setCount] = useState<number | undefined>(undefined);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [rawNotes, setRawNotes] = useState('');
  const [calendarEvents, setCalendarEvents] = useState<GoogleCalendarEvent[]>([]);
  const [selectedCalendarEventId, setSelectedCalendarEventId] = useState<number | null>(null);
  const lastSavedRawNotesRef = useRef('');
  const recordingStartedAtRef = useRef<number | null>(null);
  const headerHeight = useHeaderHeight();
  const insets = useSafeAreaInsets();
  const googleCalendarAccounts = useGoogleCalendarStore((s) => s.accounts);
  const loadGoogleCalendars = useGoogleCalendarStore((s) => s.load);
  const createMeetingNote = useNotesStore((s) => s.createMeetingNote);
  const updateNote = useNotesStore((s) => s.updateNote);
  const transitionStatus = useNotesStore((s) => s.transitionStatus);
  const runMeetingPipeline = useNotesStore((s) => s.runMeetingPipeline);
  const finalizeCloudMeeting = useNotesStore((s) => s.finalizeCloudMeeting);
  const isDiarizerAvailable = useNotesStore((s) => s.isDiarizerAvailable);
  const isDiarizerModelReady = useNotesStore((s) => s.isDiarizerModelReady);
  const isLocalAsrModelReady = useNotesStore((s) => s.isLocalAsrModelReady);
  const downloadDiarizerModel = useNotesStore((s) => s.downloadDiarizerModel);
  const { register: registerSuperwallGate } = useSuperwallGate();

  const recording = useAudioRecording({
    allowsBackgroundRecording: true,
    onError: () => setPhase('prompt'),
  });
  const cloudMeeting = useCloudMeeting({
    enabled: phase === 'cloud-recording',
    language: getPreferredTranscriptionLanguage(),
  });

  const accountsById = useMemo(
    () => new Map(googleCalendarAccounts.map((account) => [account.id, account])),
    [googleCalendarAccounts],
  );
  const selectedCalendarEvent = useMemo(
    () => calendarEvents.find((event) => event.id === selectedCalendarEventId) ?? null,
    [calendarEvents, selectedCalendarEventId],
  );
  const selectedMeetingContext = useMemo(() => {
    if (!selectedCalendarEvent) return null;
    try {
      return buildCalendarMeetingContext(
        selectedCalendarEvent,
        accountsById.get(selectedCalendarEvent.accountId),
      );
    } catch (error) {
      Sentry.captureException(error, {
        tags: { feature: 'meeting-calendar-context', calendar_context_operation: 'build' },
      });
      return null;
    }
  }, [accountsById, selectedCalendarEvent]);

  useEffect(() => {
    if (phase !== 'prompt') return;
    loadGoogleCalendars().catch((error) => {
      Sentry.captureException(error, { tags: { feature: 'meeting-calendar-suggestions' } });
    });
  }, [loadGoogleCalendars, phase]);

  useEffect(() => {
    if (phase !== 'prompt') return;
    try {
      const events = getMeetingCalendarEventSuggestions(googleCalendarAccounts, calendarRepository);
      setCalendarEvents(events);
      setSelectedCalendarEventId((current) =>
        current != null && !events.some((event) => event.id === current) ? null : current,
      );
    } catch (error) {
      setCalendarEvents([]);
      setSelectedCalendarEventId(null);
      Sentry.captureException(error, { tags: { feature: 'meeting-calendar-suggestions' } });
    }
  }, [googleCalendarAccounts, phase]);

  useEffect(() => {
    if (phase !== 'recording') {
      setElapsedSeconds(0);
      recordingStartedAtRef.current = null;
      return;
    }
    const updateElapsed = () => {
      const startedAt = recordingStartedAtRef.current;
      if (startedAt == null) return;
      setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    };
    updateElapsed();
    const interval = setInterval(updateElapsed, 1000);
    return () => clearInterval(interval);
  }, [phase]);

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

  const saveRawNotesNow = useCallback((): void => {
    if (noteId == null || rawNotes === lastSavedRawNotesRef.current) return;
    updateNote(noteId, { content: rawNotes });
    lastSavedRawNotesRef.current = rawNotes;
  }, [noteId, rawNotes, updateNote]);

  // Mark an in-flight note failed when we abandon a recording (guarded: skip if already terminal,
  // since processMeeting may have set 'failed' directly).
  const markNoteFailed = (id: number): void => {
    const status = useNotesStore.getState().notes.find((n) => n.id === id)?.transcriptionStatus;
    if (status != null && canTransition(status as TranscriptionStatus, 'failed')) {
      transitionStatus(id, 'failed');
    }
  };

  // Create the note only AFTER recording actually starts, so a denied mic permission / recorder
  // failure doesn't leave an orphan "recording" note behind (startRecording re-throws on failure).
  const startRecording = async (expected: number | undefined): Promise<void> => {
    try {
      await recording.startRecording();
    } catch {
      setPhase('prompt');
      return;
    }
    let note: Note;
    try {
      note = createMeetingNote({
        expectedSpeakerCount: expected,
        calendarEventId: selectedMeetingContext?.calendarEventId ?? null,
        title: selectedMeetingContext?.title ?? null,
        participants: selectedMeetingContext?.participants ?? null,
      });
    } catch (error) {
      Sentry.captureException(error, {
        tags: {
          feature: 'meeting-calendar-context',
          calendar_context_operation: 'create_meeting_note',
          calendar_context_selected: !!selectedMeetingContext,
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
      setPhase('prompt');
      return;
    }
    setRawNotes(note.content);
    lastSavedRawNotesRef.current = note.content;
    setNoteId(note.id);
    recordingStartedAtRef.current = Date.now();
    setPhase('recording');
  };

  const begin = async (expected: number | undefined): Promise<void> => {
    setCount(expected);
    // Cloud realtime path (signed in + not private): stream live captions instead of the
    // on-device whisper + diarizer pipeline, skipping the on-device model gates below.
    if (isCloudMeeting()) {
      startCloudMeeting(expected);
      return;
    }
    // Don't walk the user through record → transcribe only to fail: gate on platform support and a
    // downloaded speech model up front.
    if (!(await isDiarizerAvailable())) {
      setPhase('unsupported');
      return;
    }
    if (!(await isLocalAsrModelReady())) {
      Alert.alert(
        'Speech model needed',
        'Download a local speech model in Settings → AI Models → Speech to Text, then try again.',
      );
      setPhase('prompt');
      return;
    }
    if (!(await isDiarizerModelReady())) {
      setPhase('needs-model');
      return;
    }

    await registerSuperwallGate({
      placement: SUPERWALL_PLACEMENTS.meetingRecordStart,
      params: { expectedSpeakerCount: expected ?? 0 },
      requiresAccount: false,
      feature: () => {
        startRecording(expected).catch(() => setPhase('prompt'));
      },
    });
  };

  const confirmDownload = async (): Promise<void> => {
    setPhase('downloading');
    try {
      await downloadDiarizerModel();
      await startRecording(count);
    } catch (error) {
      Sentry.captureException(error);
      setPhase('prompt');
    }
  };

  const finish = async (): Promise<void> => {
    setPhase('processing');
    try {
      const uri = await recording.stopRecordingRaw();
      if (!uri || noteId == null) {
        saveRawNotesNow();
        if (noteId != null) markNoteFailed(noteId);
        setPhase('prompt');
        return;
      }
      saveRawNotesNow();
      const stableUri = `${FileSystem.documentDirectory}meeting-${noteId}.wav`;
      await FileSystem.copyAsync({ from: uri, to: stableUri });
      await runMeetingPipeline(noteId, stableUri, count);
      router.replace(`/(tabs)/(notes)/${noteId}`);
    } catch (error) {
      if (noteId != null) markNoteFailed(noteId);
      Sentry.captureException(error);
      setPhase('prompt');
    }
  };

  const isCloudMeeting = (): boolean =>
    canRunCloudMeeting(useAuthStore.getState().user, useProcessingModeStore.getState().activeMode);

  // Cloud meetings don't pre-check the mic (the realtime session requests it); the note is
  // created up front so live captions have somewhere to land. A session that never connects
  // is resolved on Stop (finishCloud) as failed rather than a done, empty note.
  const startCloudMeeting = (expected: number | undefined): void => {
    let note: Note;
    try {
      note = createMeetingNote({
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
    setPhase('cloud-recording');
  };

  const finishCloud = async (): Promise<void> => {
    const utterances = cloudMeeting.stop();
    const elapsed = cloudMeeting.elapsedSeconds;
    const hadError = cloudMeeting.status === 'error';
    setPhase('processing');
    if (noteId == null) {
      setPhase('prompt');
      return;
    }
    saveRawNotesNow();
    // A failed session with nothing transcribed shouldn't become a done, empty note.
    if (hadError && utterances.length === 0) {
      markNoteFailed(noteId);
      setPhase('prompt');
      return;
    }
    try {
      await finalizeCloudMeeting(noteId, utterances, elapsed);
      router.replace(`/(tabs)/(notes)/${noteId}`);
    } catch (error) {
      markNoteFailed(noteId);
      Sentry.captureException(error);
      setPhase('prompt');
    }
  };

  if (phase === 'prompt') {
    return (
      <SpeakerCountPrompt
        eventSlot={
          calendarEvents.length > 0 ? (
            <CalendarEventPicker
              events={calendarEvents}
              selectedEventId={selectedCalendarEventId}
              accountsById={accountsById}
              onSelect={setSelectedCalendarEventId}
            />
          ) : null
        }
        selectedEventTitle={selectedMeetingContext?.title ?? null}
        countHint={selectedMeetingContext?.suggestedSpeakerCount}
        countHintKey={selectedCalendarEventId}
        onSubmit={(n) => {
          begin(n).catch(() => setPhase('prompt'));
        }}
      />
    );
  }
  if (phase === 'unsupported') {
    return (
      <View className="flex-1 gap-4 bg-systemBackground px-6" style={{ paddingTop: headerHeight }}>
        <Text className="text-2xl font-bold text-label">Not available on this device</Text>
        <Text className="text-base text-secondaryLabel">
          Meeting diarization runs on the Apple Neural Engine and needs iOS 17+ in a development or
          production build (not Expo Go or other platforms).
        </Text>
        <Button variant="secondary" onPress={() => router.back()}>
          Go back
        </Button>
      </View>
    );
  }
  if (phase === 'needs-model') {
    return (
      <View className="flex-1 gap-4 bg-systemBackground px-6" style={{ paddingTop: headerHeight }}>
        <Text className="text-2xl font-bold text-label">Download diarization model</Text>
        <Text className="text-base text-secondaryLabel">
          A one-time ~100 MB download. Runs fully on-device after that.
        </Text>
        <Button
          testID="model-download"
          onPress={() => {
            confirmDownload().catch(Sentry.captureException);
          }}
        >
          Download
        </Button>
        <Button testID="model-cancel" variant="secondary" onPress={() => setPhase('prompt')}>
          Cancel
        </Button>
      </View>
    );
  }
  if (phase === 'recording') {
    const countLabel =
      count != null ? `${count} ${count === 1 ? 'person' : 'people'}` : 'Auto-detecting';
    const footerBottomPadding = Math.max(insets.bottom + 32, 56);
    return (
      <KeyboardAvoidingView
        className="flex-1 bg-systemBackground px-6"
        style={{ paddingTop: headerHeight }}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={headerHeight}
      >
        <View className="items-center pb-2 pt-4">
          <View className="mb-3 flex-row items-center gap-2">
            <View className="h-2 w-2 rounded-full bg-systemRed" />
            <Text className="text-[14px] font-medium text-secondaryLabel">Recording</Text>
          </View>
          <Text
            className="text-[60px] font-semibold leading-none tracking-tight text-label"
            style={{ fontVariant: ['tabular-nums'] }}
          >
            {formatClock(elapsedSeconds)}
          </Text>
          <View className="mt-5 flex-row gap-2">
            <View
              className="rounded-full border border-separator bg-secondarySystemGroupedBackground px-3 py-1.5"
              style={{ borderCurve: 'continuous' }}
            >
              <Text className="text-[12px] font-semibold text-secondaryLabel">{countLabel}</Text>
            </View>
            <View
              className="rounded-full border border-separator bg-secondarySystemGroupedBackground px-3 py-1.5"
              style={{ borderCurve: 'continuous' }}
            >
              <Text className="text-[12px] font-semibold text-secondaryLabel">On-device</Text>
            </View>
          </View>
        </View>
        <View
          className="mb-4 mt-6 flex-1 rounded-[22px] border border-separator bg-secondarySystemGroupedBackground p-4 shadow-sm"
          style={{ borderCurve: 'continuous' }}
        >
          <View className="mb-2 flex-row items-center justify-between">
            <Text className="text-[15px] font-semibold text-label">Meeting notes</Text>
            <Text className="text-[12px] font-medium text-tertiaryLabel">Draft</Text>
          </View>
          <TextInput
            testID="meeting-raw-notes"
            value={rawNotes}
            onChangeText={setRawNotes}
            placeholder="Jot decisions, follow-ups, or context while recording..."
            placeholderTextColor={iosColor('tertiaryLabel')}
            multiline
            textAlignVertical="top"
            className="flex-1 text-[16px] leading-6 text-label"
          />
        </View>
        <View style={{ paddingBottom: footerBottomPadding }}>
          <Button
            testID="meeting-stop"
            variant="destructive"
            size="lg"
            onPress={() => {
              finish().catch(Sentry.captureException);
            }}
          >
            Stop
          </Button>
        </View>
      </KeyboardAvoidingView>
    );
  }

  if (phase === 'cloud-recording') {
    return (
      <CloudMeetingRecording
        status={cloudMeeting.status}
        error={cloudMeeting.error}
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
          {phase === 'downloading' ? 'Downloading model…' : 'Preparing meeting notes…'}
        </Text>
        <Text className="text-[13px] text-tertiaryLabel">
          {phase === 'downloading'
            ? 'One-time ~100 MB · then fully on-device'
            : 'Transcribing · separating voices · finalizing note'}
        </Text>
      </View>
    </View>
  );
};
