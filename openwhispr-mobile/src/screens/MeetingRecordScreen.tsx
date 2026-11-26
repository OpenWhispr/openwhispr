import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';
import { Alert, TextInput, View } from 'react-native';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useHeaderHeight } from '@react-navigation/elements';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text } from '@/components/ui/Text';
import { Button } from '@/components/ui/Button';
import { ProcessingWaveform } from '@/components/features/WaveformVisualizer';
import { CalendarEventPicker } from '@/components/notes/CalendarEventPicker';
import { CloudMeetingRecording } from '@/components/notes/CloudMeetingRecording';
import {
  useMeetingSession,
  type MeetingSession,
  type MeetingSessionPhase,
  type MeetingStartInput,
} from '@/components/notes/MeetingSessionProvider';
import { SpeakerCountPrompt } from '@/components/notes/SpeakerCountPrompt';
import { BRAND, iosColor } from '@/config/colors';
import { calendarRepository } from '@/data/calendarRepository';
import type { GoogleCalendarEvent } from '@/data/calendarTypes';
import { useKeyboardHeight } from '@/hooks/useKeyboardHeight';
import { useSuperwallGate } from '@/hooks/useSuperwallGate';
import { canRunCloudMeeting } from '@/lib/accountAccess';
import { buildCalendarMeetingContext } from '@/lib/calendar/meetingContext';
import { getMeetingCalendarEventSuggestions } from '@/lib/calendar/meetingSuggestions';
import { Sentry } from '@/lib/sentry';
import { formatClock } from '@/lib/notes/meetingCapture';
import { SUPERWALL_PLACEMENTS } from '@/lib/superwall';
import { useAuthStore } from '@/store/useAuthStore';
import { useGoogleCalendarStore } from '@/store/useGoogleCalendarStore';
import { useNotesStore } from '@/store/useNotesStore';
import { useProcessingModeStore } from '@/store/useProcessingModeStore';

// What the screen walks through before a meeting exists; once one does, the session's phase wins.
type PreStartPhase = 'prompt' | 'unsupported' | 'needs-model' | 'downloading';
type Phase = PreStartPhase | 'starting' | Exclude<MeetingSessionPhase, 'idle'>;

/**
 * A view of the app-wide meeting session: it gathers what a meeting needs and starts one, then
 * shows it. Leaving the screen (Back, a tab switch) never stops the meeting; only Stop does.
 */
export const MeetingRecordScreen = (): React.JSX.Element => {
  const session = useMeetingSession();
  // Callbacks that resolve later (a download, the paywall) must start with the current session.
  const sessionRef = useRef<MeetingSession>(session);
  sessionRef.current = session;
  const [localPhase, setLocalPhase] = useState<PreStartPhase>('prompt');
  const [count, setCount] = useState<number | undefined>(undefined);
  const [calendarEvents, setCalendarEvents] = useState<GoogleCalendarEvent[]>([]);
  const [selectedCalendarEventId, setSelectedCalendarEventId] = useState<number | null>(null);
  // A download or paywall that resolves after the user has left must not start a meeting.
  const mountedRef = useRef(true);
  const gateAbortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      gateAbortRef.current?.abort();
    };
  }, []);

  // A finish reported before this screen opened belongs to a meeting the user already left; it is
  // acknowledged without navigating. Latched at mount so StrictMode's second effect run agrees.
  const staleFinishRef = useRef<number | null>(session.finishedNoteId);
  // Every finish this screen has navigated for, so StrictMode's second effect run or a re-render
  // never replaces to the same note twice. Kept for the screen's life.
  const navigatedNoteRef = useRef<number | null>(null);
  // Set when this screen replaces itself with the finished note, so the render after the
  // acknowledgement keeps the processing view instead of flashing the prompt. State, not a ref:
  // clearing it (the screen is shown again, or a new meeting starts) must re-render.
  const [handedOff, setHandedOff] = useState(false);
  const handingOff =
    session.phase === 'idle' &&
    ((session.finishedNoteId != null && session.finishedNoteId !== staleFinishRef.current) ||
      handedOff);
  // While the provider waits for the recorder the meeting has no phase yet; the prompt would
  // invite a second start the provider refuses anyway.
  const phase: Phase = handingOff
    ? 'processing'
    : session.phase !== 'idle'
      ? session.phase
      : session.starting
        ? 'starting'
        : localPhase;

  const headerHeight = useHeaderHeight();
  const insets = useSafeAreaInsets();
  // Only the recording phase has a notes field to keep above the keyboard.
  const keyboardHeight = useKeyboardHeight(phase === 'recording');
  const googleCalendarAccounts = useGoogleCalendarStore((s) => s.accounts);
  const loadGoogleCalendars = useGoogleCalendarStore((s) => s.load);
  const isDiarizerAvailable = useNotesStore((s) => s.isDiarizerAvailable);
  const isDiarizerModelReady = useNotesStore((s) => s.isDiarizerModelReady);
  const isLocalAsrModelReady = useNotesStore((s) => s.isLocalAsrModelReady);
  const downloadDiarizerModel = useNotesStore((s) => s.downloadDiarizerModel);
  const { register: registerSuperwallGate } = useSuperwallGate();
  // Where the meeting was started from; createMeetingNote files it there when it still can.
  // Ignored while a meeting runs: it was filed when it started.
  const params = useLocalSearchParams<{ folderId?: string; spaceId?: string }>();
  const startedIn = {
    folderId: params.folderId ? Number(params.folderId) : undefined,
    spaceId: params.spaceId ? Number(params.spaceId) : undefined,
  };

  // Whether the user is looking at this screen. A screen left mounted in the Notes stack while
  // the user is on another tab must not pull them into the note when a meeting finishes.
  const focusedRef = useRef(false);
  const { finishedNoteId, acknowledgeFinished } = session;
  useEffect(() => {
    if (finishedNoteId == null) return;
    if (!focusedRef.current && finishedNoteId !== navigatedNoteRef.current) {
      // Acknowledged like a finish from before the screen opened: on return, the start prompt.
      staleFinishRef.current = finishedNoteId;
    }
    if (finishedNoteId === staleFinishRef.current) {
      acknowledgeFinished();
      return;
    }
    if (navigatedNoteRef.current === finishedNoteId) return;
    navigatedNoteRef.current = finishedNoteId;
    setHandedOff(true);
    router.replace(`/(tabs)/(notes)/${finishedNoteId}`);
    acknowledgeFinished();
  }, [finishedNoteId, acknowledgeFinished]);

  // A screen the replace didn't remove (or one the user comes back to) must not stay on
  // "Preparing meeting notes…": once it has been left and is shown again, show its normal phase.
  const blurredRef = useRef(false);
  useFocusEffect(
    useCallback(() => {
      focusedRef.current = true;
      if (blurredRef.current) {
        blurredRef.current = false;
        setHandedOff(false);
      }
      return () => {
        focusedRef.current = false;
        blurredRef.current = true;
      };
    }, []),
  );
  // A new meeting replaces the finished one; when it ends, its own outcome decides the view.
  useEffect(() => {
    if (session.phase !== 'idle') setHandedOff(false);
  }, [session.phase]);

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

  const buildStartInput = (expected: number | undefined): MeetingStartInput => ({
    expectedSpeakerCount: expected,
    folderId: startedIn.folderId,
    spaceId: startedIn.spaceId,
    context: selectedMeetingContext,
  });

  // Once the session holds the meeting its phase is shown, so the screen's own phase goes back to
  // the prompt: that is what shows if the meeting fails to start or ends without a note.
  const startLocalMeeting = async (input: MeetingStartInput): Promise<void> => {
    if (!mountedRef.current) return;
    await sessionRef.current.startLocal(input);
    if (mountedRef.current) setLocalPhase('prompt');
  };

  const isCloudMeeting = (): boolean =>
    canRunCloudMeeting(useAuthStore.getState().user, useProcessingModeStore.getState().activeMode);

  const begin = async (expected: number | undefined): Promise<void> => {
    // A meeting already running is shown instead of the prompt; never start a second one.
    if (sessionRef.current.phase !== 'idle') return;
    setCount(expected);
    const input = buildStartInput(expected);
    // Cloud realtime path (signed in + not private): stream live captions instead of the
    // on-device whisper + diarizer pipeline, skipping the on-device model gates below.
    if (isCloudMeeting()) {
      sessionRef.current.startCloud(input);
      return;
    }
    // Don't walk the user through record → transcribe only to fail: gate on platform support and a
    // downloaded speech model up front.
    if (!(await isDiarizerAvailable())) {
      if (mountedRef.current) setLocalPhase('unsupported');
      return;
    }
    if (!(await isLocalAsrModelReady())) {
      if (!mountedRef.current) return;
      Alert.alert(
        'Speech model needed',
        'Download a local speech model in Settings → AI Models → Dictation, then try again.',
      );
      setLocalPhase('prompt');
      return;
    }
    if (!(await isDiarizerModelReady())) {
      if (mountedRef.current) setLocalPhase('needs-model');
      return;
    }
    if (!mountedRef.current) return;

    gateAbortRef.current?.abort();
    const gateAbort = new AbortController();
    gateAbortRef.current = gateAbort;
    await registerSuperwallGate({
      placement: SUPERWALL_PLACEMENTS.meetingRecordStart,
      params: { expectedSpeakerCount: expected ?? 0 },
      requiresAccount: false,
      signal: gateAbort.signal,
      feature: () => {
        startLocalMeeting(input).catch((error) => {
          Sentry.captureException(error);
          if (mountedRef.current) setLocalPhase('prompt');
        });
      },
    });
  };

  const confirmDownload = async (): Promise<void> => {
    setLocalPhase('downloading');
    try {
      await downloadDiarizerModel();
      await startLocalMeeting(buildStartInput(count));
    } catch (error) {
      Sentry.captureException(error);
      if (mountedRef.current) setLocalPhase('prompt');
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
          begin(n).catch((error) => {
            Sentry.captureException(error);
            if (mountedRef.current) setLocalPhase('prompt');
          });
        }}
      />
    );
  }
  if (phase === 'unsupported') {
    return (
      <View className="flex-1 gap-4 bg-systemBackground px-6" style={{ paddingTop: headerHeight }}>
        <Text accessibilityRole="header" className="text-2xl font-bold text-label">
          Not available on this device
        </Text>
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
        <Text accessibilityRole="header" className="text-2xl font-bold text-label">
          Download diarization model
        </Text>
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
        <Button testID="model-cancel" variant="secondary" onPress={() => setLocalPhase('prompt')}>
          Cancel
        </Button>
      </View>
    );
  }
  if (phase === 'recording') {
    const { expectedSpeakerCount, capturing, capturedSeconds } = session;
    const countLabel =
      expectedSpeakerCount != null
        ? `${expectedSpeakerCount} ${expectedSpeakerCount === 1 ? 'person' : 'people'}`
        : 'Auto-detecting';
    // The view fills the screen, so the keyboard covers the home-indicator inset too.
    const footerBottomPadding =
      keyboardHeight > 0 ? keyboardHeight + 12 : Math.max(insets.bottom + 32, 56);
    return (
      <View className="flex-1 bg-systemBackground px-6" style={{ paddingTop: headerHeight }}>
        <View className="items-center pb-2 pt-4">
          <View className="mb-3 flex-row items-center gap-2">
            <View
              className={`h-2 w-2 rounded-full ${capturing ? 'bg-systemRed' : 'bg-tertiaryLabel'}`}
            />
            <Text className="text-[14px] font-medium text-secondaryLabel">
              {capturing ? 'Recording' : 'Not recording'}
            </Text>
          </View>
          <Text
            className="text-[60px] font-semibold leading-none tracking-tight text-label"
            style={{ fontVariant: ['tabular-nums'] }}
          >
            {formatClock(capturedSeconds)}
          </Text>
          {capturing ? null : (
            <Text className="mt-3 text-center text-[13px] text-systemRed">
              The microphone was interrupted. Trying to resume…
            </Text>
          )}
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
            value={session.rawNotes}
            onChangeText={session.setRawNotes}
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
              session.stop().catch(Sentry.captureException);
            }}
          >
            Stop
          </Button>
        </View>
      </View>
    );
  }

  if (phase === 'cloud-recording') {
    return (
      <CloudMeetingRecording
        status={session.cloud.status}
        captureStarted={session.cloud.liveSinceMs !== null}
        error={session.cloud.error}
        startFailed={session.cloud.startFailure != null}
        recording={session.cloud.recording}
        capturedSeconds={session.capturedSeconds}
        rawNotes={session.rawNotes}
        onChangeRawNotes={session.setRawNotes}
        utterances={session.cloud.utterances}
        partialText={session.cloud.partialText}
        onStop={() => {
          session.stop().catch(Sentry.captureException);
        }}
      />
    );
  }

  if (phase === 'starting') {
    return (
      <View className="flex-1 items-center justify-center gap-7 bg-systemBackground px-6">
        <ProcessingWaveform color={BRAND} size={48} />
        <Text className="text-lg font-semibold text-label">Starting recording…</Text>
      </View>
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
            : session.path === 'cloud'
              ? 'Finishing the transcript…'
              : 'Transcribing · separating voices · finalizing note'}
        </Text>
      </View>
    </View>
  );
};
