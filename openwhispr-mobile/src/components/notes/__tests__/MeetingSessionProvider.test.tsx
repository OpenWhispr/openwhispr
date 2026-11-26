import React from 'react';
import { act, render } from '@testing-library/react-native';
import {
  MeetingSessionProvider,
  useLiveMeetingNoteId,
  useMeetingSession,
  type MeetingSession,
} from '@/components/notes/MeetingSessionProvider';
import type { CloudMeetingResult } from '@/hooks/useCloudMeeting';
import { isMeetingActive, stopActiveMeeting } from '@/lib/notes/activeMeeting';
import { alertCloudMeetingCapture, alertIfPartialCapture } from '@/lib/meetingCaptureAlerts';
import { useMeetingLiveActivity } from '@/hooks/useMeetingLiveActivity';
import { alertMeetingStartFailed } from '@/lib/alerts';
import { showMicPermissionAlert } from '@/lib/permissions';
import type { MeetingStartFailure } from '@/lib/notes/meetingCapture';

interface MockNote {
  id: number;
  content: string;
  transcriptionStatus: string;
}

const mockState = {
  notes: [] as MockNote[],
  createMeetingNote: jest.fn(),
  updateNote: jest.fn(),
  transitionStatus: jest.fn(),
  deleteNote: jest.fn(),
  runMeetingPipeline: jest.fn(),
  finalizeCloudMeeting: jest.fn(),
  appendCloudMeetingUtterance: jest.fn(),
};

jest.mock('@/store/useNotesStore', () => {
  const useNotesStore = (selector?: (state: unknown) => unknown): unknown =>
    selector ? selector(mockState) : mockState;
  useNotesStore.getState = (): unknown => mockState;
  return { useNotesStore };
});

const mockRecording = {
  startRecording: jest.fn(),
  stopRecordingRaw: jest.fn(),
  cancelRecording: jest.fn(),
  canResumeRecording: jest.fn(() => true),
  audioRecorder: null,
};
let mockAudioOptions: { onError?: (error: Error) => void } = {};

jest.mock('@/hooks/useAudioRecording', () => ({
  useAudioRecording: (options: { onError?: (error: Error) => void }) => {
    mockAudioOptions = options;
    return mockRecording;
  },
}));

const mockCloud = {
  status: 'live',
  error: null as string | null,
  startFailure: null as MeetingStartFailure | null,
  partialText: '',
  utterances: [],
  capturedSeconds: 30,
  droppedSeconds: 0,
  interruptions: 0,
  reconnects: 0,
  liveSinceMs: null as number | null,
  stop: jest.fn(),
};
let mockCloudEnabled = false;
let mockCloudRetained: boolean | undefined;

jest.mock('@/hooks/useCloudMeeting', () => ({
  useCloudMeeting: (options: { enabled: boolean; retained?: boolean }) => {
    mockCloudEnabled = options.enabled;
    mockCloudRetained = options.retained;
    return mockCloud;
  },
}));

jest.mock('@/hooks/useMeetingRecorderHealth', () => ({
  useMeetingRecorderHealth: () => ({ capturing: true, capturedMs: 5000 }),
}));

jest.mock('@/hooks/useMeetingLiveActivity', () => ({
  useMeetingLiveActivity: jest.fn(),
}));

jest.mock('@/lib/meetingCaptureAlerts', () => ({
  alertCloudMeetingCapture: jest.fn(),
  alertIfPartialCapture: jest.fn(),
  useCapturePausedNotification: jest.fn(),
}));

jest.mock('@/lib/meetingCaptureTelemetry', () => ({
  reportCaptureInterrupted: jest.fn(),
  reportMeetingFinished: jest.fn(),
}));

jest.mock('@/lib/alerts', () => ({ alertMeetingStartFailed: jest.fn() }));

jest.mock('@/lib/permissions', () => ({ showMicPermissionAlert: jest.fn() }));

const mockUpdateNoteMeta = jest.fn();
jest.mock('@/data', () => ({
  notesRepository: { updateNoteMeta: (...args: unknown[]) => mockUpdateNoteMeta(...args) },
}));

const mockCopyAsync = jest.fn();
const mockDeleteAsync = jest.fn();
const mockGetInfoAsync = jest.fn();
jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///docs/',
  copyAsync: (...args: unknown[]) => mockCopyAsync(...args),
  deleteAsync: (...args: unknown[]) => mockDeleteAsync(...args),
  getInfoAsync: (...args: unknown[]) => mockGetInfoAsync(...args),
}));

jest.mock('@/lib/transcriptAudio', () => ({
  excludeMeetingFileFromBackup: jest.fn(() => Promise.resolve()),
  meetingRecordingUri: (noteId: number) => `file:///docs/meeting-audio/${noteId}.wav`,
}));

jest.mock('@/lib/sentry', () => ({
  Sentry: { captureException: jest.fn(), captureMessage: jest.fn() },
}));

jest.mock('@/lib/transcriptionLanguage', () => ({
  getPreferredTranscriptionLanguage: () => 'en',
}));

const mockAccountLinks = new Set<string>();
jest.mock('@/sync/syncIdentity', () => ({
  isAccountLink: (from: string, to: string) => mockAccountLinks.has(`${from}>${to}`),
}));

jest.mock('@/store/useAuthStore', () => {
  let userId: string | null = null;
  const listeners = new Set<() => void>();
  const React = jest.requireActual<typeof import('react')>('react');
  const useAuthStore = (selector: (state: { user: { id: string } | null }) => unknown): unknown => {
    const [, force] = React.useReducer((n: number) => n + 1, 0);
    React.useEffect(() => {
      const listener = (): void => force();
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }, []);
    return selector({ user: userId ? { id: userId } : null });
  };
  useAuthStore.getState = (): { user: { id: string } | null } => ({
    user: userId ? { id: userId } : null,
  });
  return {
    useAuthStore,
    __setUser: (next: string | null) => {
      userId = next;
      listeners.forEach((listener) => listener());
    },
  };
});

let session: MeetingSession;

const Probe = (): null => {
  session = useMeetingSession();
  return null;
};

// A fresh element each time, or React skips the provider's re-render altogether.
const providerTree = (): React.JSX.Element => (
  <MeetingSessionProvider>
    <Probe />
  </MeetingSessionProvider>
);

const renderProvider = (): ReturnType<typeof render> => render(providerTree());

const CALL_FAILURE: MeetingStartFailure = {
  code: 'MIC_UNAVAILABLE',
  message: 'Session activation failed',
};

// What the cloud hook reports when its session's start was refused: nothing was captured.
const refuseCloudStart = (failure: MeetingStartFailure = CALL_FAILURE): void => {
  mockCloud.status = 'error';
  mockCloud.error = failure.message;
  mockCloud.startFailure = failure;
};

const setMockUser = (id: string | null): void => {
  (
    jest.requireMock('@/store/useAuthStore') as { __setUser: (id: string | null) => void }
  ).__setUser(id);
};

const input = { expectedSpeakerCount: 3, folderId: 7, context: null };

const meetingNote = (id: number, content = ''): MockNote => ({
  id,
  content,
  transcriptionStatus: 'recording',
});

beforeEach(() => {
  jest.clearAllMocks();
  setMockUser(null);
  mockState.notes = [];
  mockState.createMeetingNote.mockImplementation(() => {
    const note = meetingNote(42);
    mockState.notes = [note];
    return note;
  });
  mockState.runMeetingPipeline.mockResolvedValue(undefined);
  mockState.finalizeCloudMeeting.mockResolvedValue({ owedMs: 0 });
  mockRecording.startRecording.mockResolvedValue(undefined);
  mockRecording.stopRecordingRaw.mockResolvedValue('file:///tmp/recording.wav');
  mockRecording.cancelRecording.mockResolvedValue(undefined);
  mockCopyAsync.mockResolvedValue(undefined);
  mockDeleteAsync.mockResolvedValue(undefined);
  mockGetInfoAsync.mockResolvedValue({ exists: false });
  const result: CloudMeetingResult = {
    utterances: [],
    droppedWindows: [],
    recordingUri: 'file:///docs/meeting-audio/42.wav',
  };
  mockCloud.stop.mockResolvedValue(result);
  mockCloud.status = 'live';
  mockCloud.error = null;
  mockCloud.startFailure = null;
  mockCloud.liveSinceMs = null;
  mockAudioOptions = {};
  mockAccountLinks.clear();
});

describe('MeetingSessionProvider', () => {
  it('throws a clear error outside the provider', () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => render(<Probe />)).toThrow(/MeetingSessionProvider/);
  });

  it('starts idle with no side effects', () => {
    renderProvider();
    expect(session.phase).toBe('idle');
    expect(session.starting).toBe(false);
    expect(session.noteId).toBeNull();
    expect(mockCloudEnabled).toBe(false);
    expect(mockState.createMeetingNote).not.toHaveBeenCalled();
    expect(mockRecording.startRecording).not.toHaveBeenCalled();
  });

  it('startCloud creates the note and enters cloud-recording', () => {
    renderProvider();
    let started = false;
    act(() => {
      started = session.startCloud(input);
    });
    expect(started).toBe(true);
    expect(mockState.createMeetingNote).toHaveBeenCalledWith(
      expect.objectContaining({
        folderId: 7,
        expectedSpeakerCount: 3,
        diarizationEnabled: false,
      }),
    );
    expect(session.phase).toBe('cloud-recording');
    expect(session.path).toBe('cloud');
    expect(session.noteId).toBe(42);
    expect(session.expectedSpeakerCount).toBe(3);
    expect(mockCloudEnabled).toBe(true);
  });

  it('startLocal creates the note only after the recorder starts', async () => {
    let resolveStart: () => void = () => undefined;
    mockRecording.startRecording.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveStart = resolve;
      }),
    );
    renderProvider();
    let pending: Promise<boolean> = Promise.resolve(false);
    act(() => {
      pending = session.startLocal(input);
    });
    expect(mockState.createMeetingNote).not.toHaveBeenCalled();
    // Views see the wait, so none offers a second start meanwhile.
    expect(session.starting).toBe(true);
    expect(session.phase).toBe('idle');
    let started = false;
    await act(async () => {
      resolveStart();
      started = await pending;
    });
    expect(started).toBe(true);
    expect(session.starting).toBe(false);
    expect(mockState.createMeetingNote).toHaveBeenCalledTimes(1);
    expect(session.phase).toBe('recording');
    expect(session.path).toBe('local');
    expect(session.noteId).toBe(42);
  });

  it('startLocal creates no note when the recorder fails to start', async () => {
    mockRecording.startRecording.mockRejectedValue(new Error('denied'));
    renderProvider();
    let started = true;
    await act(async () => {
      started = await session.startLocal(input);
    });
    expect(started).toBe(false);
    expect(mockState.createMeetingNote).not.toHaveBeenCalled();
    expect(session.phase).toBe('idle');
    expect(session.starting).toBe(false);
  });

  it('a second start is refused while active', async () => {
    renderProvider();
    let first = false;
    let second = true;
    act(() => {
      first = session.startCloud(input);
      second = session.startCloud(input);
    });
    expect(first).toBe(true);
    expect(second).toBe(false);
    let local = true;
    await act(async () => {
      local = await session.startLocal(input);
    });
    expect(local).toBe(false);
    expect(mockRecording.startRecording).not.toHaveBeenCalled();
    expect(mockState.createMeetingNote).toHaveBeenCalledTimes(1);
  });

  it('stop on cloud finalizes and sets finishedNoteId', async () => {
    renderProvider();
    act(() => {
      session.startCloud(input);
    });
    await act(async () => {
      await session.stop();
    });
    expect(mockUpdateNoteMeta).toHaveBeenCalledWith(42, {
      sourceFile: 'file:///docs/meeting-audio/42.wav',
    });
    expect(mockState.finalizeCloudMeeting).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ recordingUri: 'file:///docs/meeting-audio/42.wav' }),
      30,
      expect.objectContaining({ fence: expect.anything() }),
    );
    expect(alertCloudMeetingCapture).toHaveBeenCalledTimes(1);
    expect(session.finishedNoteId).toBe(42);
    expect(session.phase).toBe('idle');
    // Back to idle, the cloud hook lets go of the finished meeting's transcript.
    expect(mockCloudRetained).toBe(false);
    act(() => {
      session.acknowledgeFinished();
    });
    expect(session.finishedNoteId).toBeNull();
  });

  it('stop on local runs the pipeline with the stable uri', async () => {
    renderProvider();
    await act(async () => {
      await session.startLocal(input);
    });
    await act(async () => {
      await session.stop();
    });
    expect(mockCopyAsync).toHaveBeenCalledWith({
      from: 'file:///tmp/recording.wav',
      to: 'file:///docs/meeting-42.wav',
    });
    expect(mockDeleteAsync).toHaveBeenCalledWith('file:///tmp/recording.wav', {
      idempotent: true,
    });
    expect(mockState.runMeetingPipeline).toHaveBeenCalledWith(
      42,
      'file:///docs/meeting-42.wav',
      3,
      expect.objectContaining({ fence: expect.anything() }),
    );
    expect(session.finishedNoteId).toBe(42);
    expect(session.phase).toBe('idle');
  });

  it('a recorder error mid-meeting finishes the meeting and keeps the recording', async () => {
    renderProvider();
    await act(async () => {
      await session.startLocal(input);
    });
    await act(async () => {
      mockAudioOptions.onError?.(new Error('recorder died'));
    });
    // Cancelling would delete the recorder's file: the meeting goes through the normal finish.
    expect(mockRecording.cancelRecording).not.toHaveBeenCalled();
    expect(mockRecording.stopRecordingRaw).toHaveBeenCalledTimes(1);
    expect(mockState.runMeetingPipeline).toHaveBeenCalledWith(
      42,
      'file:///docs/meeting-42.wav',
      3,
      expect.anything(),
    );
    expect(session.phase).toBe('idle');
  });

  it('a recorder error while the start waits cancels the recorder so the lease is released', async () => {
    let rejectStart: (error: Error) => void = () => undefined;
    mockRecording.startRecording.mockReturnValue(
      new Promise<void>((_resolve, reject) => {
        rejectStart = reject;
      }),
    );
    renderProvider();
    let pending: Promise<boolean> = Promise.resolve(true);
    act(() => {
      pending = session.startLocal(input);
    });
    let started = true;
    await act(async () => {
      mockAudioOptions.onError?.(new Error('denied'));
      rejectStart(new Error('denied'));
      started = await pending;
    });
    expect(started).toBe(false);
    expect(mockRecording.cancelRecording).toHaveBeenCalledTimes(1);
    expect(mockState.createMeetingNote).not.toHaveBeenCalled();
    expect(session.phase).toBe('idle');
  });

  it('a recorder error during a cloud meeting leaves it running', () => {
    renderProvider();
    act(() => {
      session.startCloud(input);
    });
    act(() => {
      mockAudioOptions.onError?.(new Error('refused dictation'));
    });
    expect(session.phase).toBe('cloud-recording');
    expect(mockState.transitionStatus).not.toHaveBeenCalled();
    expect(mockRecording.cancelRecording).not.toHaveBeenCalled();
  });

  it('a recorder error while processing does not tear the meeting down', async () => {
    let resolveStop: (uri: string | null) => void = () => undefined;
    mockRecording.stopRecordingRaw.mockReturnValue(
      new Promise<string | null>((resolve) => {
        resolveStop = resolve;
      }),
    );
    renderProvider();
    await act(async () => {
      await session.startLocal(input);
    });
    let stopping: Promise<void> = Promise.resolve();
    act(() => {
      stopping = session.stop();
    });
    expect(session.phase).toBe('processing');
    act(() => {
      mockAudioOptions.onError?.(new Error('late error'));
    });
    expect(session.phase).toBe('processing');
    expect(mockState.transitionStatus).not.toHaveBeenCalled();
    expect(mockRecording.cancelRecording).not.toHaveBeenCalled();
    await act(async () => {
      resolveStop('file:///tmp/recording.wav');
      await stopping;
    });
  });

  it('local stop with no recording uri marks the note failed', async () => {
    mockRecording.stopRecordingRaw.mockResolvedValue(null);
    renderProvider();
    await act(async () => {
      await session.startLocal(input);
    });
    await act(async () => {
      await session.stop();
    });
    expect(mockState.transitionStatus).toHaveBeenCalledWith(42, 'failed');
    expect(mockState.runMeetingPipeline).not.toHaveBeenCalled();
    expect(session.phase).toBe('idle');
  });

  it('a cloud stop that errored with nothing transcribed marks the note failed', async () => {
    mockCloud.status = 'error';
    mockCloud.stop.mockResolvedValue({ utterances: [], droppedWindows: [] });
    renderProvider();
    act(() => {
      session.startCloud(input);
    });
    await act(async () => {
      await session.stop();
    });
    expect(mockState.transitionStatus).toHaveBeenCalledWith(42, 'failed');
    expect(mockState.finalizeCloudMeeting).not.toHaveBeenCalled();
    expect(session.phase).toBe('idle');
  });

  it('a cloud stop that rejects fails the note and returns to idle', async () => {
    mockCloud.stop.mockRejectedValue(new Error('socket gone'));
    mockGetInfoAsync.mockResolvedValue({ exists: true, size: 4096 });
    renderProvider();
    act(() => {
      session.startCloud(input);
    });
    await act(async () => {
      await session.stop();
    });
    // The recording at its managed path is kept on the note, so Retry has the audio.
    expect(mockUpdateNoteMeta).toHaveBeenCalledWith(42, {
      sourceFile: 'file:///docs/meeting-audio/42.wav',
    });
    expect(mockState.transitionStatus).toHaveBeenCalledWith(42, 'failed');
    expect(session.phase).toBe('idle');
    expect(isMeetingActive()).toBe(false);
  });

  it('a failure linking the recording still fails the note and returns to idle', async () => {
    mockCloud.stop.mockRejectedValue(new Error('socket gone'));
    mockGetInfoAsync.mockRejectedValue(new Error('unreadable'));
    renderProvider();
    act(() => {
      session.startCloud(input);
    });
    await act(async () => {
      await session.stop();
    });
    expect(mockUpdateNoteMeta).not.toHaveBeenCalled();
    expect(mockState.transitionStatus).toHaveBeenCalledWith(42, 'failed');
    expect(session.phase).toBe('idle');
  });

  it('after a failed finish a new meeting can start', async () => {
    mockUpdateNoteMeta.mockImplementationOnce(() => {
      throw new Error('database locked');
    });
    renderProvider();
    act(() => {
      session.startCloud(input);
    });
    await act(async () => {
      await session.stop();
    });
    expect(session.phase).toBe('idle');
    let started = false;
    act(() => {
      started = session.startCloud(input);
    });
    expect(started).toBe(true);
    expect(session.phase).toBe('cloud-recording');
  });

  it('a failure mark that throws still returns the session to idle', async () => {
    mockUpdateNoteMeta.mockImplementationOnce(() => {
      throw new Error('database locked');
    });
    mockState.transitionStatus.mockImplementationOnce(() => {
      throw new Error('database locked');
    });
    renderProvider();
    act(() => {
      session.startCloud(input);
    });
    await act(async () => {
      await session.stop();
    });
    expect(mockState.transitionStatus).toHaveBeenCalledWith(42, 'failed');
    expect(session.phase).toBe('idle');
  });

  it('a start is refused while processing', async () => {
    let resolveStop: (result: CloudMeetingResult) => void = () => undefined;
    mockCloud.stop.mockReturnValue(
      new Promise<CloudMeetingResult>((resolve) => {
        resolveStop = resolve;
      }),
    );
    renderProvider();
    act(() => {
      session.startCloud(input);
    });
    let stopping: Promise<void> = Promise.resolve();
    act(() => {
      stopping = session.stop();
    });
    expect(session.phase).toBe('processing');
    // Still finishing: the transcript stays readable.
    expect(mockCloudRetained).toBe(true);
    let cloud = true;
    let local = true;
    await act(async () => {
      cloud = session.startCloud(input);
      local = await session.startLocal(input);
    });
    expect(cloud).toBe(false);
    expect(local).toBe(false);
    expect(mockState.createMeetingNote).toHaveBeenCalledTimes(1);
    expect(mockRecording.startRecording).not.toHaveBeenCalled();
    await act(async () => {
      resolveStop({ utterances: [], droppedWindows: [], recordingUri: 'file:///x.wav' });
      await stopping;
    });
  });

  it('the live-note context does not change while the captured clock ticks', async () => {
    let liveRenders = 0;
    const seen: (number | null)[] = [];
    // Memoised and prop-less: it re-renders only when the context value it reads changes.
    const LiveProbe = React.memo((): null => {
      liveRenders += 1;
      seen.push(useLiveMeetingNoteId());
      return null;
    });
    // A fresh element each time, or React skips the provider's re-render altogether.
    const tree = (): React.JSX.Element => (
      <MeetingSessionProvider>
        <Probe />
        <LiveProbe />
      </MeetingSessionProvider>
    );
    const view = render(tree());
    expect(liveRenders).toBe(1);

    act(() => {
      session.startCloud(input);
    });
    expect(liveRenders).toBe(2);

    for (let tick = 1; tick <= 3; tick += 1) {
      mockCloud.capturedSeconds = 30 + tick;
      mockCloud.utterances = [{ itemId: `u${tick}` }] as never;
      act(() => view.rerender(tree()));
    }
    // The session value moved on every tick; the live-note consumer did not render again.
    expect(session.capturedSeconds).toBe(33);
    expect(liveRenders).toBe(2);

    await act(async () => {
      await session.stop();
    });
    expect(liveRenders).toBe(3);
    expect(seen).toEqual([null, 42, null]);
  });

  it('a recorder error before any note marks nothing failed', () => {
    renderProvider();
    act(() => {
      mockAudioOptions.onError?.(new Error('denied'));
    });
    expect(mockState.transitionStatus).not.toHaveBeenCalled();
  });

  it('stop flushes unsaved rawNotes first', async () => {
    let resolveStop: (result: CloudMeetingResult) => void = () => undefined;
    mockCloud.stop.mockReturnValue(
      new Promise<CloudMeetingResult>((resolve) => {
        resolveStop = resolve;
      }),
    );
    renderProvider();
    act(() => {
      session.startCloud(input);
    });
    act(() => {
      session.setRawNotes('Decided to ship Friday');
    });
    let stopping: Promise<void> = Promise.resolve();
    act(() => {
      stopping = session.stop();
    });
    // Saved before the session's stop settles, not left to the debounce.
    expect(mockState.updateNote).toHaveBeenCalledWith(42, { content: 'Decided to ship Friday' });
    await act(async () => {
      resolveStop({ utterances: [], droppedWindows: [], recordingUri: null });
      await stopping;
    });
    expect(mockState.updateNote).toHaveBeenCalledTimes(1);
  });

  it('the lock-screen End ends the meeting with no screen mounted', async () => {
    renderProvider();
    await act(async () => {
      await session.startLocal(input);
    });
    const calls = jest.mocked(useMeetingLiveActivity).mock.calls;
    const { onEndRequested } = calls[calls.length - 1][0];
    await act(async () => {
      onEndRequested();
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockRecording.stopRecordingRaw).toHaveBeenCalledTimes(1);
    expect(mockState.runMeetingPipeline).toHaveBeenCalledTimes(1);
    expect(session.phase).toBe('idle');
  });

  it('two stops finalize once', async () => {
    renderProvider();
    act(() => {
      session.startCloud(input);
    });
    await act(async () => {
      await Promise.all([session.stop(), session.stop()]);
    });
    expect(mockCloud.stop).toHaveBeenCalledTimes(1);
    expect(mockState.finalizeCloudMeeting).toHaveBeenCalledTimes(1);
  });

  describe('a cloud start that fails', () => {
    it('returns to idle, removes the empty note and says why', () => {
      let activeWhenDeleted: boolean | null = null;
      mockState.deleteNote.mockImplementation(() => {
        // The store refuses to delete the live meeting's note, so the session lets go first.
        activeWhenDeleted = isMeetingActive();
      });
      const view = renderProvider();
      act(() => {
        session.startCloud(input);
      });

      act(() => {
        refuseCloudStart();
        view.rerender(providerTree());
      });

      expect(session.phase).toBe('idle');
      expect(session.noteId).toBeNull();
      expect(mockState.deleteNote).toHaveBeenCalledTimes(1);
      expect(mockState.deleteNote).toHaveBeenCalledWith(42);
      expect(activeWhenDeleted).toBe(false);
      expect(mockState.transitionStatus).not.toHaveBeenCalled();
      expect(alertMeetingStartFailed).toHaveBeenCalledTimes(1);
      expect(alertMeetingStartFailed).toHaveBeenCalledWith(
        "Can't record during a call. End the call, then try again.",
      );
      // Nothing was captured: no session to stop and nothing to finalize.
      expect(mockCloud.stop).not.toHaveBeenCalled();
      expect(mockState.finalizeCloudMeeting).not.toHaveBeenCalled();
      expect(session.finishedNoteId).toBeNull();
    });

    it('lets a new meeting start right after', () => {
      const view = renderProvider();
      act(() => {
        session.startCloud(input);
      });
      act(() => {
        refuseCloudStart();
        view.rerender(providerTree());
      });
      // The hook starts the next session with no start failure.
      mockCloud.status = 'connecting';
      mockCloud.error = null;
      mockCloud.startFailure = null;

      let started = false;
      act(() => {
        started = session.startCloud(input);
      });

      expect(started).toBe(true);
      expect(session.phase).toBe('cloud-recording');
      expect(mockCloudEnabled).toBe(true);
      expect(mockState.deleteNote).toHaveBeenCalledTimes(1);
      expect(alertMeetingStartFailed).toHaveBeenCalledTimes(1);
    });

    it('keeps a note the user already wrote in, saved and marked failed', () => {
      const view = renderProvider();
      act(() => {
        session.startCloud(input);
      });
      act(() => {
        session.setRawNotes('Agenda: pricing');
      });

      act(() => {
        refuseCloudStart();
        view.rerender(providerTree());
      });

      expect(session.phase).toBe('idle');
      expect(mockState.deleteNote).not.toHaveBeenCalled();
      expect(mockState.updateNote).toHaveBeenCalledWith(42, { content: 'Agenda: pricing' });
      expect(mockState.transitionStatus).toHaveBeenCalledWith(42, 'failed');
      expect(alertMeetingStartFailed).toHaveBeenCalledTimes(1);
    });

    it('shows the microphone access alert when permission was denied', () => {
      const view = renderProvider();
      act(() => {
        session.startCloud(input);
      });

      act(() => {
        refuseCloudStart({
          code: 'MIC_PERMISSION_DENIED',
          message: 'Microphone permission was not granted',
        });
        view.rerender(providerTree());
      });

      expect(showMicPermissionAlert).toHaveBeenCalledTimes(1);
      expect(alertMeetingStartFailed).not.toHaveBeenCalled();
      expect(mockState.deleteNote).toHaveBeenCalledWith(42);
    });

    it('a Stop racing the failure ends the meeting once, without the finish', async () => {
      const view = renderProvider();
      act(() => {
        session.startCloud(input);
      });

      let stopping: Promise<void> = Promise.resolve();
      act(() => {
        refuseCloudStart();
        view.rerender(providerTree());
        stopping = session.stop();
      });
      await act(async () => {
        await stopping;
        await session.stop();
      });

      expect(session.phase).toBe('idle');
      expect(mockCloud.stop).not.toHaveBeenCalled();
      expect(mockState.finalizeCloudMeeting).not.toHaveBeenCalled();
      expect(mockState.transitionStatus).not.toHaveBeenCalled();
      expect(mockState.deleteNote).toHaveBeenCalledTimes(1);
      expect(alertMeetingStartFailed).toHaveBeenCalledTimes(1);
    });

    it('a failure seen after the account changed keeps the note and tells no one', async () => {
      setMockUser('first');
      const view = renderProvider();
      act(() => {
        session.startCloud(input);
      });

      await act(async () => {
        refuseCloudStart();
        view.rerender(providerTree());
        setMockUser('second');
      });

      expect(session.phase).toBe('idle');
      expect(mockState.deleteNote).not.toHaveBeenCalled();
      expect(mockState.transitionStatus).toHaveBeenCalledWith(42, 'failed');
      expect(alertMeetingStartFailed).not.toHaveBeenCalled();
      expect(mockCloud.stop).not.toHaveBeenCalled();
    });

    it('a session that ends mid-meeting still waits for Stop', async () => {
      const view = renderProvider();
      act(() => {
        session.startCloud(input);
      });
      act(() => {
        mockCloud.status = 'error';
        view.rerender(providerTree());
      });

      expect(session.phase).toBe('cloud-recording');
      expect(mockState.deleteNote).not.toHaveBeenCalled();
      expect(alertMeetingStartFailed).not.toHaveBeenCalled();

      await act(async () => {
        await session.stop();
      });
      expect(mockCloud.stop).toHaveBeenCalledTimes(1);
    });
  });

  describe('non-React access', () => {
    it('isMeetingActive is true while a local start is in progress', async () => {
      let resolveStart: () => void = () => undefined;
      mockRecording.startRecording.mockReturnValue(
        new Promise<void>((resolve) => {
          resolveStart = resolve;
        }),
      );
      renderProvider();
      expect(isMeetingActive()).toBe(false);
      let pending: Promise<boolean> = Promise.resolve(false);
      act(() => {
        pending = session.startLocal(input);
      });
      expect(isMeetingActive()).toBe(true);
      await act(async () => {
        resolveStart();
        await pending;
      });
      expect(isMeetingActive()).toBe(true);
    });

    it('stopActiveMeeting settles a cloud meeting', async () => {
      renderProvider();
      act(() => {
        session.startCloud(input);
      });
      await act(async () => {
        await stopActiveMeeting();
      });
      expect(mockState.finalizeCloudMeeting).toHaveBeenCalledTimes(1);
      expect(session.phase).toBe('idle');
      expect(isMeetingActive()).toBe(false);
    });

    it('stopActiveMeeting waits for a finish already in flight', async () => {
      let resolveStop: (result: CloudMeetingResult) => void = () => undefined;
      mockCloud.stop.mockReturnValue(
        new Promise<CloudMeetingResult>((resolve) => {
          resolveStop = resolve;
        }),
      );
      renderProvider();
      act(() => {
        session.startCloud(input);
      });
      act(() => {
        void session.stop();
      });
      let settled = false;
      let waiting: Promise<void> = Promise.resolve();
      act(() => {
        waiting = stopActiveMeeting().then(() => {
          settled = true;
        });
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(settled).toBe(false);
      await act(async () => {
        resolveStop({ utterances: [], droppedWindows: [], recordingUri: null });
        await waiting;
      });
      expect(settled).toBe(true);
      expect(mockCloud.stop).toHaveBeenCalledTimes(1);
      expect(session.phase).toBe('idle');
    });

    it('a local stop resolves once capture stopped, leaving the pipeline running', async () => {
      let resolvePipeline: () => void = () => undefined;
      mockState.runMeetingPipeline.mockReturnValue(
        new Promise<void>((resolve) => {
          resolvePipeline = resolve;
        }),
      );
      renderProvider();
      await act(async () => {
        await session.startLocal(input);
      });
      await act(async () => {
        await stopActiveMeeting();
      });
      expect(mockRecording.stopRecordingRaw).toHaveBeenCalledTimes(1);
      expect(session.phase).toBe('processing');
      expect(isMeetingActive()).toBe(true);
      await act(async () => {
        resolvePipeline();
      });
      expect(session.phase).toBe('idle');
    });

    it('an account change while recording stops the meeting', async () => {
      setMockUser('first');
      renderProvider();
      act(() => {
        session.startCloud(input);
      });
      await act(async () => {
        setMockUser('second');
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(mockCloud.stop).toHaveBeenCalledTimes(1);
      expect(session.phase).toBe('idle');
    });

    it('an anonymous session linking to an account does not stop the meeting', async () => {
      setMockUser('anon');
      renderProvider();
      act(() => {
        session.startCloud(input);
      });
      mockAccountLinks.add('anon>real');
      await act(async () => {
        setMockUser('real');
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(mockCloud.stop).not.toHaveBeenCalled();
      expect(session.phase).toBe('cloud-recording');
      // Its processing still runs for the person who recorded it.
      await act(async () => {
        await session.stop();
      });
      const options = mockState.finalizeCloudMeeting.mock.calls[0][3] as {
        fence: { isCurrent: () => boolean };
      };
      expect(options.fence.isCurrent()).toBe(true);
    });

    describe('an account change during on-device processing', () => {
      let resolvePipeline: () => void = () => undefined;

      const startStopping = async (): Promise<void> => {
        mockState.runMeetingPipeline.mockReturnValue(
          new Promise<void>((resolve) => {
            resolvePipeline = resolve;
          }),
        );
        setMockUser('first');
        renderProvider();
        await act(async () => {
          await session.startLocal(input);
        });
        act(() => {
          void session.stop();
        });
        await act(async () => {
          await Promise.resolve();
          await Promise.resolve();
        });
        expect(session.phase).toBe('processing');
        expect(mockState.runMeetingPipeline).toHaveBeenCalledTimes(1);
        await act(async () => {
          setMockUser('second');
        });
        await act(async () => {
          await Promise.resolve();
          await Promise.resolve();
        });
      };

      it('returns to idle at once', async () => {
        await startStopping();
        expect(session.phase).toBe('idle');
        expect(session.noteId).toBeNull();
        expect(isMeetingActive()).toBe(false);
        await act(async () => {
          resolvePipeline();
        });
      });

      it('the old pipeline finishing afterwards raises no navigation signal and no alert', async () => {
        await startStopping();
        await act(async () => {
          resolvePipeline();
        });
        expect(session.finishedNoteId).toBeNull();
        expect(alertIfPartialCapture).not.toHaveBeenCalled();
        expect(session.phase).toBe('idle');
      });

      it('a new meeting started meanwhile is not reset when the old pipeline ends', async () => {
        await startStopping();
        mockState.createMeetingNote.mockImplementation(() => {
          const note = meetingNote(43);
          mockState.notes = [note];
          return note;
        });
        act(() => {
          session.startCloud(input);
        });
        expect(session.noteId).toBe(43);
        await act(async () => {
          resolvePipeline();
        });
        expect(session.phase).toBe('cloud-recording');
        expect(session.noteId).toBe(43);
        expect(isMeetingActive()).toBe(true);
        // Its own stop still finishes normally.
        await act(async () => {
          await session.stop();
        });
        expect(mockState.finalizeCloudMeeting).toHaveBeenCalledWith(
          43,
          expect.anything(),
          expect.any(Number),
          expect.anything(),
        );
        expect(session.finishedNoteId).toBe(43);
      });

      it('a sign-out that waited only for capture leaves nothing behind', async () => {
        mockState.runMeetingPipeline.mockReturnValue(
          new Promise<void>((resolve) => {
            resolvePipeline = resolve;
          }),
        );
        setMockUser('first');
        renderProvider();
        await act(async () => {
          await session.startLocal(input);
        });
        // Sign-out: settle first, then the account goes.
        await act(async () => {
          await stopActiveMeeting();
        });
        expect(session.phase).toBe('processing');
        await act(async () => {
          setMockUser(null);
        });
        await act(async () => {
          await Promise.resolve();
          await Promise.resolve();
        });
        expect(session.phase).toBe('idle');
        await act(async () => {
          resolvePipeline();
        });
        expect(session.finishedNoteId).toBeNull();
        expect(alertIfPartialCapture).not.toHaveBeenCalled();
      });
    });

    it('stopActiveMeeting during a pending local start settles the note', async () => {
      let resolveStart: () => void = () => undefined;
      mockRecording.startRecording.mockReturnValue(
        new Promise<void>((resolve) => {
          resolveStart = resolve;
        }),
      );
      renderProvider();
      let pending: Promise<boolean> = Promise.resolve(false);
      let stopping: Promise<void> = Promise.resolve();
      act(() => {
        pending = session.startLocal(input);
        stopping = stopActiveMeeting();
      });
      // No flush between the start resolving and the stop proceeding: the render that follows the
      // start has not committed, so the finish must not depend on it.
      await act(async () => {
        resolveStart();
        await pending;
        await stopping;
      });
      expect(mockRecording.stopRecordingRaw).toHaveBeenCalledTimes(1);
      expect(mockState.runMeetingPipeline).toHaveBeenCalledWith(
        42,
        'file:///docs/meeting-42.wav',
        3,
        expect.objectContaining({ fence: expect.anything() }),
      );
    });

    it('a no-uri stop in the same tick as the start marks the note failed', async () => {
      mockRecording.stopRecordingRaw.mockResolvedValue(null);
      let resolveStart: () => void = () => undefined;
      mockRecording.startRecording.mockReturnValue(
        new Promise<void>((resolve) => {
          resolveStart = resolve;
        }),
      );
      renderProvider();
      let pending: Promise<boolean> = Promise.resolve(false);
      let stopping: Promise<void> = Promise.resolve();
      act(() => {
        pending = session.startLocal(input);
        stopping = stopActiveMeeting();
      });
      await act(async () => {
        resolveStart();
        await pending;
        await stopping;
      });
      expect(mockState.transitionStatus).toHaveBeenCalledWith(42, 'failed');
    });

    it('a cloud meeting stopped in the tick it started is finalized', async () => {
      renderProvider();
      let stopping: Promise<void> = Promise.resolve();
      await act(async () => {
        session.startCloud(input);
        stopping = stopActiveMeeting();
        await stopping;
      });
      expect(mockCloud.stop).toHaveBeenCalledTimes(1);
      expect(mockState.finalizeCloudMeeting).toHaveBeenCalledWith(
        42,
        expect.anything(),
        expect.any(Number),
        expect.objectContaining({ fence: expect.anything() }),
      );
    });

    it('a guest session starting does not stop the meeting', async () => {
      renderProvider();
      act(() => {
        session.startCloud(input);
      });
      await act(async () => {
        setMockUser(null);
      });
      expect(mockCloud.stop).not.toHaveBeenCalled();
      expect(session.phase).toBe('cloud-recording');
    });

    it('the initial sign-in does not stop anything', async () => {
      renderProvider();
      act(() => {
        session.startCloud(input);
      });
      await act(async () => {
        setMockUser('first');
      });
      expect(mockCloud.stop).not.toHaveBeenCalled();
      expect(session.phase).toBe('cloud-recording');
    });
  });
});
