jest.mock('expo-sqlite/localStorage/install', () => ({}));
jest.mock('expo-file-system/legacy', () => ({ documentDirectory: 'file:///docs/' }));
jest.mock('@/data', () => ({ notesRepository: { getAllNotes: jest.fn(() => []) } }));
jest.mock('@/store/useNotesStore', () => ({ useNotesStore: { getState: jest.fn() } }));
jest.mock('@/lib/sentry', () => ({ Sentry: { captureException: jest.fn() } }));
jest.mock('expo-network', () => ({ getNetworkStateAsync: jest.fn() }));
jest.mock('../../../modules/live-pcm-streaming/src', () => ({
  LivePCMStreaming: { repairRecording: jest.fn() },
}));
jest.mock('@/lib/transcriptAudio', () => ({
  isManagedMeetingAudioUri: (noteId: number, uri?: string | null) =>
    uri === `file:///docs/meeting-${noteId}.wav`,
  meetingRecordingUri: (noteId: number) => `file:///docs/meeting-${noteId}.wav`,
  clearPendingBackfill: jest.fn(),
}));

import type { AppStateStatus } from 'react-native';
import type { Note } from '@/data';
import {
  MEETING_RESUME_MARKER_PREFIX,
  STALE_RECORDING_MS,
  createdBeforeRuntime,
  recoverOrphanedMeetings,
  repairMeetingRecordings,
  waitForAppActive,
  type MeetingRecoveryDeps,
} from '@/lib/meetingRecovery';

function note(overrides: Partial<Note> & { id: number }): Note {
  return {
    noteType: 'meeting',
    transcriptionStatus: 'transcribing',
    sourceFile: `file:///docs/meeting-${overrides.id}.wav`,
    ...overrides,
  } as Note;
}

interface Harness {
  deps: MeetingRecoveryDeps;
  store: Map<string, string>;
  calls: string[];
}

function makeDeps(notes: Note[], initialStorage: Record<string, string> = {}): Harness {
  const store = new Map(Object.entries(initialStorage));
  const calls: string[] = [];
  const deps: MeetingRecoveryDeps = {
    listNotes: jest.fn(() => notes),
    markFailed: jest.fn((id: number) => {
      calls.push(`failed:${id}`);
    }),
    waitUntilActive: jest.fn(() => Promise.resolve()),
    resume: jest.fn(async (id: number) => {
      calls.push(`resume:${id}`);
    }),
    storage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        calls.push(`set:${key}`);
        store.set(key, value);
      },
      removeItem: (key: string) => {
        calls.push(`remove:${key}`);
        store.delete(key);
      },
    },
    reportError: jest.fn(),
    hasTranscript: jest.fn(() => false),
    keepTranscript: jest.fn((id: number) => {
      calls.push(`keep:${id}`);
    }),
    finishNotes: jest.fn(async (id: number) => {
      calls.push(`finish:${id}`);
    }),
    repairRecording: jest.fn(async () => false),
    recordingUri: (id: number) => `file:///docs/meeting-${id}.wav`,
    linkRecording: jest.fn((id: number) => {
      calls.push(`link:${id}`);
    }),
    labelSpeakers: jest.fn(async (id: number) => {
      calls.push(`label:${id}`);
      return true;
    }),
    hasSpeakerLabels: jest.fn(() => false),
    discardRecording: jest.fn(async (id: number) => {
      calls.push(`discard:${id}`);
    }),
    recordingAgeMs: jest.fn(async () => 0),
    listPendingBackfills: jest.fn(async () => []),
    getNote: jest.fn((id: number) => notes.find((candidate) => candidate.id === id) ?? null),
    recordingExists: jest.fn(async () => true),
    deletePendingBackfill: jest.fn(async (id: number) => {
      calls.push(`clearSidecar:${id}`);
    }),
    wasRelinked: jest.fn(() => false),
    isOnline: jest.fn(async () => true),
    resumeBackfill: jest.fn(async (id: number) => {
      calls.push(`backfill:${id}`);
    }),
  };
  return { deps, store, calls };
}

const marker = (id: number): string => `${MEETING_RESUME_MARKER_PREFIX}${id}`;

// Recovery reads the disk before it reaches the orphans.
const flushMicrotasks = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('recoverOrphanedMeetings with a saved live transcript', () => {
  const recordingNote = (id: number): Note =>
    note({ id, transcriptionStatus: 'recording', sourceFile: null });

  it('keeps the transcript of a recording orphan that has segments', async () => {
    const { deps, calls } = makeDeps([recordingNote(5)]);
    (deps.hasTranscript as jest.Mock).mockReturnValue(true);
    (deps.waitUntilActive as jest.Mock).mockImplementation(async () => {
      calls.push('active');
    });

    await recoverOrphanedMeetings(deps);

    expect(deps.markFailed).not.toHaveBeenCalled();
    expect(deps.resume).not.toHaveBeenCalled();
    expect(calls).toEqual(['keep:5', 'active', 'finish:5']);
  });

  it('still fails a recording orphan with no segments', async () => {
    const { deps, calls } = makeDeps([recordingNote(6)]);

    await recoverOrphanedMeetings(deps);

    expect(deps.keepTranscript).not.toHaveBeenCalled();
    expect(calls).toEqual(['failed:6']);
  });

  it('falls back to failed when keeping the transcript throws', async () => {
    const { deps, calls } = makeDeps([recordingNote(7)]);
    (deps.hasTranscript as jest.Mock).mockReturnValue(true);
    const failure = new Error('cannot transition');
    (deps.keepTranscript as jest.Mock).mockImplementation(() => {
      throw failure;
    });

    await recoverOrphanedMeetings(deps);

    expect(deps.reportError).toHaveBeenCalledWith(failure, 7);
    expect(calls).toEqual(['failed:7']);
    expect(deps.finishNotes).not.toHaveBeenCalled();
  });

  it('reports and continues when finishing the notes throws', async () => {
    const { deps } = makeDeps([recordingNote(8), recordingNote(9)]);
    (deps.hasTranscript as jest.Mock).mockReturnValue(true);
    const failure = new Error('summary failed');
    (deps.finishNotes as jest.Mock).mockRejectedValueOnce(failure);

    await recoverOrphanedMeetings(deps);

    expect(deps.reportError).toHaveBeenCalledWith(failure, 8);
    expect(deps.markFailed).not.toHaveBeenCalled();
    expect(deps.keepTranscript).toHaveBeenCalledWith(9);
    expect(deps.finishNotes).toHaveBeenCalledWith(9);
  });
});

describe('recoverOrphanedMeetings', () => {
  it.each(['transcribing', 'diarizing'])(
    'marks a %s orphan failed, then resumes it once behind a marker',
    async (status) => {
      const { deps, store, calls } = makeDeps([note({ id: 1, transcriptionStatus: status })]);
      await recoverOrphanedMeetings(deps);
      expect(calls).toEqual(['failed:1', `set:${marker(1)}`, 'resume:1', `remove:${marker(1)}`]);
      expect(store.has(marker(1))).toBe(false);
    },
  );

  it('does not resume a second time when the marker survived a crash', async () => {
    const { deps, store } = makeDeps([note({ id: 2 })], { [marker(2)]: '1' });
    await recoverOrphanedMeetings(deps);
    expect(deps.markFailed).toHaveBeenCalledWith(2);
    expect(deps.resume).not.toHaveBeenCalled();
    expect(store.has(marker(2))).toBe(false);
  });

  it('fails a note left in recording without resuming', async () => {
    const { deps } = makeDeps([note({ id: 3, transcriptionStatus: 'recording' })]);
    await recoverOrphanedMeetings(deps);
    expect(deps.markFailed).toHaveBeenCalledWith(3);
    expect(deps.resume).not.toHaveBeenCalled();
  });

  it('fails without resuming when there is no managed meeting WAV', async () => {
    const { deps } = makeDeps([
      note({ id: 4, sourceFile: null }),
      note({ id: 5, sourceFile: 'file:///elsewhere/meeting-5.wav' }),
    ]);
    await recoverOrphanedMeetings(deps);
    expect(deps.markFailed).toHaveBeenCalledWith(4);
    expect(deps.markFailed).toHaveBeenCalledWith(5);
    expect(deps.resume).not.toHaveBeenCalled();
  });

  it('leaves settled and non-meeting notes alone', async () => {
    const { deps } = makeDeps([
      note({ id: 6, transcriptionStatus: 'done' }),
      note({ id: 7, transcriptionStatus: 'failed' }),
      note({ id: 8, transcriptionStatus: 'idle' }),
      note({ id: 9, transcriptionStatus: null }),
      note({ id: 10, noteType: 'personal', transcriptionStatus: 'transcribing' }),
    ]);
    await recoverOrphanedMeetings(deps);
    expect(deps.markFailed).not.toHaveBeenCalled();
    expect(deps.resume).not.toHaveBeenCalled();
  });

  it('a failing resume is reported and the sweep continues', async () => {
    const { deps, store } = makeDeps([note({ id: 11 }), note({ id: 12 })]);
    const boom = new Error('pipeline crashed');
    (deps.resume as jest.Mock).mockImplementationOnce(async () => {
      throw boom;
    });
    await recoverOrphanedMeetings(deps);
    expect(deps.reportError).toHaveBeenCalledWith(boom, 11);
    expect(deps.resume).toHaveBeenCalledWith(12);
    expect(store.has(marker(11))).toBe(false);
    expect(store.has(marker(12))).toBe(false);
  });

  it('skips the resume when marking failed throws', async () => {
    const { deps, calls } = makeDeps([note({ id: 13 })]);
    const illegal = new Error('Illegal transcription status transition');
    (deps.markFailed as jest.Mock).mockImplementationOnce(() => {
      throw illegal;
    });
    await recoverOrphanedMeetings(deps);
    expect(deps.reportError).toHaveBeenCalledWith(illegal, 13);
    expect(deps.resume).not.toHaveBeenCalled();
    expect(calls).toEqual([`remove:${marker(13)}`]);
  });

  it('marks failed immediately but sets the marker and resumes only once active', async () => {
    const { deps, calls } = makeDeps([note({ id: 17 })]);
    let becomeActive: () => void = () => {};
    (deps.waitUntilActive as jest.Mock).mockImplementationOnce(
      () => new Promise<void>((resolve) => (becomeActive = resolve)),
    );
    const sweep = recoverOrphanedMeetings(deps);
    await flushMicrotasks();
    expect(calls).toEqual(['failed:17']);
    becomeActive();
    await sweep;
    expect(calls).toEqual(['failed:17', `set:${marker(17)}`, 'resume:17', `remove:${marker(17)}`]);
  });

  it('resumes one note at a time', async () => {
    const { deps } = makeDeps([note({ id: 14 }), note({ id: 15 })]);
    let releaseFirst: () => void = () => {};
    (deps.resume as jest.Mock).mockImplementationOnce(
      () => new Promise<void>((resolve) => (releaseFirst = resolve)),
    );
    const sweep = recoverOrphanedMeetings(deps);
    await flushMicrotasks();
    expect(deps.resume).toHaveBeenCalledTimes(1);
    releaseFirst();
    await sweep;
    expect(deps.resume).toHaveBeenCalledTimes(2);
  });

  it('reads the note list once, before any resume', async () => {
    const { deps } = makeDeps([note({ id: 16 })]);
    await recoverOrphanedMeetings(deps);
    expect(deps.listNotes).toHaveBeenCalledTimes(1);
  });
});

describe('recoverOrphanedMeetings with the meeting recording', () => {
  const killed = (id: number, overrides: Partial<Note> = {}): Note =>
    note({ id, transcriptionStatus: 'recording', sourceFile: null, ...overrides });
  const DAY = 24 * 60 * 60 * 1000;

  it('repairs and links the recording of a killed cloud meeting', async () => {
    const { deps } = makeDeps([killed(1)]);
    (deps.repairRecording as jest.Mock).mockResolvedValue(true);

    await recoverOrphanedMeetings(deps);

    expect(deps.repairRecording).toHaveBeenCalledWith('file:///docs/meeting-1.wav');
    expect(deps.linkRecording).toHaveBeenCalledWith(1, 'file:///docs/meeting-1.wav');
  });

  it('labels speakers after keeping a recovered transcript', async () => {
    const { deps, calls } = makeDeps([killed(2)]);
    (deps.repairRecording as jest.Mock).mockResolvedValue(true);
    (deps.hasTranscript as jest.Mock).mockReturnValue(true);
    (deps.waitUntilActive as jest.Mock).mockImplementation(async () => {
      calls.push('active');
    });

    await recoverOrphanedMeetings(deps);

    expect(calls).toEqual(['link:2', 'keep:2', 'active', 'label:2', 'discard:2', 'finish:2']);
    expect(deps.markFailed).not.toHaveBeenCalled();
    expect(deps.resume).not.toHaveBeenCalled();
  });

  it('transcribes a killed meeting from its recording when no transcript was saved', async () => {
    const { deps, store, calls } = makeDeps([killed(3)]);
    (deps.repairRecording as jest.Mock).mockResolvedValue(true);

    await recoverOrphanedMeetings(deps);

    expect(calls).toEqual([
      'link:3',
      'failed:3',
      `set:${marker(3)}`,
      'resume:3',
      `remove:${marker(3)}`,
    ]);
    expect(store.has(marker(3))).toBe(false);

    // A resume that already ran once (its marker survived a crash) is not run again.
    const second = makeDeps([killed(3)], { [marker(3)]: '1' });
    (second.deps.repairRecording as jest.Mock).mockResolvedValue(true);
    await recoverOrphanedMeetings(second.deps);
    expect(second.deps.resume).not.toHaveBeenCalled();
    expect(second.deps.markFailed).toHaveBeenCalledWith(3);
    expect(second.store.has(marker(3))).toBe(false);
  });

  it('does not link a recording that could not be repaired', async () => {
    const { deps, calls } = makeDeps([killed(4)]);

    await recoverOrphanedMeetings(deps);

    expect(deps.linkRecording).not.toHaveBeenCalled();
    expect(deps.resume).not.toHaveBeenCalled();
    expect(calls).toEqual(['failed:4']);
  });

  it('leaves orphans without a recording exactly as before', async () => {
    const { deps, calls } = makeDeps([killed(5), killed(6)]);
    (deps.hasTranscript as jest.Mock).mockImplementation((id: number) => id === 5);
    (deps.waitUntilActive as jest.Mock).mockImplementation(async () => {
      calls.push('active');
    });

    await recoverOrphanedMeetings(deps);

    expect(calls).toEqual(['keep:5', 'active', 'finish:5', 'failed:6']);
    expect(deps.labelSpeakers).not.toHaveBeenCalled();
    expect(deps.discardRecording).not.toHaveBeenCalled();
  });

  it('discards the recording after recovering a transcript', async () => {
    const { deps } = makeDeps([killed(7)]);
    (deps.repairRecording as jest.Mock).mockResolvedValue(true);
    (deps.hasTranscript as jest.Mock).mockReturnValue(true);
    (deps.labelSpeakers as jest.Mock).mockRejectedValue(new Error('diarizer'));

    await recoverOrphanedMeetings(deps);

    expect(deps.discardRecording).toHaveBeenCalledWith(7);
    expect(deps.finishNotes).toHaveBeenCalledWith(7);
  });

  it('keeps the live transcript of a cloud meeting killed while labelling speakers', async () => {
    const { deps, calls } = makeDeps([note({ id: 8, transcriptionStatus: 'diarizing' })]);
    (deps.hasTranscript as jest.Mock).mockReturnValue(true);

    await recoverOrphanedMeetings(deps);

    expect(calls).toEqual(['keep:8', 'label:8', 'discard:8', 'finish:8']);
    expect(deps.markFailed).not.toHaveBeenCalled();
    expect(deps.resume).not.toHaveBeenCalled();
    expect(deps.repairRecording).not.toHaveBeenCalled();

    // Killed after the labels were written: they are not redone.
    const labelled = makeDeps([note({ id: 9, transcriptionStatus: 'diarizing' })]);
    (labelled.deps.hasTranscript as jest.Mock).mockReturnValue(true);
    (labelled.deps.hasSpeakerLabels as jest.Mock).mockReturnValue(true);
    await recoverOrphanedMeetings(labelled.deps);
    expect(labelled.calls).toEqual(['keep:9', 'discard:9', 'finish:9']);
  });

  it('keeps the live transcript of a cloud meeting killed during the post-pass', async () => {
    const { deps, calls } = makeDeps([note({ id: 10, transcriptionStatus: 'transcribing' })]);
    (deps.hasTranscript as jest.Mock).mockReturnValue(true);

    await recoverOrphanedMeetings(deps);

    expect(calls).toEqual(['keep:10', 'label:10', 'discard:10', 'finish:10']);
    expect(deps.resume).not.toHaveBeenCalled();
  });

  it('never resumes a cloud transcript that could not be kept', async () => {
    const { deps, calls } = makeDeps([note({ id: 11, transcriptionStatus: 'diarizing' })]);
    (deps.hasTranscript as jest.Mock).mockReturnValue(true);
    (deps.keepTranscript as jest.Mock).mockImplementation(() => {
      throw new Error('cannot transition');
    });

    await recoverOrphanedMeetings(deps);

    expect(calls).toEqual(['failed:11']);
    expect(deps.resume).not.toHaveBeenCalled();
  });

  it('resumes the owed backfill of a kept transcript instead of discarding its recording', async () => {
    const { deps, calls } = makeDeps([note({ id: 12, transcriptionStatus: 'transcribing' })]);
    (deps.hasTranscript as jest.Mock).mockReturnValue(true);
    (deps.hasSpeakerLabels as jest.Mock).mockReturnValue(true);
    (deps.listPendingBackfills as jest.Mock).mockResolvedValue([12]);

    await recoverOrphanedMeetings(deps);

    expect(calls).toEqual(['keep:12', 'backfill:12', 'finish:12']);
  });

  it('leaves an on-device meeting killed while transcribing exactly as before', async () => {
    const { deps, calls } = makeDeps([
      note({ id: 13, transcriptionStatus: 'transcribing', diarizationEnabled: 1 }),
    ]);

    await recoverOrphanedMeetings(deps);

    expect(calls).toEqual(['failed:13', `set:${marker(13)}`, 'resume:13', `remove:${marker(13)}`]);
    expect(deps.keepTranscript).not.toHaveBeenCalled();
    expect(deps.discardRecording).not.toHaveBeenCalled();
  });

  it('discards a failed cloud meeting recording older than 7 days', async () => {
    const { deps } = makeDeps([
      note({ id: 20, transcriptionStatus: 'failed', diarizationEnabled: 0 }),
    ]);
    (deps.recordingAgeMs as jest.Mock).mockResolvedValue(STALE_RECORDING_MS + 1);

    await recoverOrphanedMeetings(deps);

    expect(deps.recordingAgeMs).toHaveBeenCalledWith('file:///docs/meeting-20.wav');
    expect(deps.discardRecording).toHaveBeenCalledWith(20);
  });

  it('keeps a failed cloud meeting recording younger than 7 days', async () => {
    const { deps } = makeDeps([
      note({ id: 21, transcriptionStatus: 'failed', diarizationEnabled: 0 }),
      note({ id: 22, transcriptionStatus: 'failed', diarizationEnabled: 0 }),
    ]);
    (deps.recordingAgeMs as jest.Mock).mockImplementation(async (uri: string) =>
      uri.endsWith('-21.wav') ? 3 * DAY : null,
    );

    await recoverOrphanedMeetings(deps);

    expect(deps.discardRecording).not.toHaveBeenCalled();
    expect(deps.markFailed).not.toHaveBeenCalled();
    expect(deps.resume).not.toHaveBeenCalled();
  });

  it('applies the 7-day rule to a failed on-device meeting too', async () => {
    const { deps } = makeDeps([
      note({ id: 23, transcriptionStatus: 'failed', diarizationEnabled: 1 }),
    ]);
    (deps.recordingAgeMs as jest.Mock).mockResolvedValue(8 * DAY);

    await recoverOrphanedMeetings(deps);

    expect(deps.discardRecording).toHaveBeenCalledWith(23);
  });

  it('never discards the recording of a note that is still recording, transcribing or diarizing', async () => {
    const { deps } = makeDeps([
      note({ id: 24, transcriptionStatus: 'recording' }),
      note({ id: 25, transcriptionStatus: 'transcribing' }),
      note({ id: 26, transcriptionStatus: 'diarizing' }),
    ]);
    (deps.recordingAgeMs as jest.Mock).mockResolvedValue(30 * DAY);
    (deps.listPendingBackfills as jest.Mock).mockResolvedValue([24, 25, 26]);

    await recoverOrphanedMeetings(deps);

    expect(deps.discardRecording).not.toHaveBeenCalled();
    expect(deps.deletePendingBackfill).not.toHaveBeenCalled();
  });

  describe('a done meeting that still owes audio', () => {
    const owing = (id: number): Note => note({ id, transcriptionStatus: 'done' });

    it('resumes the backfill when online', async () => {
      const { deps, calls } = makeDeps([owing(30), note({ id: 31, transcriptionStatus: 'done' })]);
      (deps.listPendingBackfills as jest.Mock).mockResolvedValue([30]);

      await recoverOrphanedMeetings(deps);

      expect(calls).toEqual(['backfill:30']);
    });

    it('leaves everything when offline', async () => {
      const { deps } = makeDeps([owing(32)]);
      (deps.listPendingBackfills as jest.Mock).mockResolvedValue([32]);
      (deps.isOnline as jest.Mock).mockResolvedValue(false);

      await recoverOrphanedMeetings(deps);

      expect(deps.resumeBackfill).not.toHaveBeenCalled();
      expect(deps.discardRecording).not.toHaveBeenCalled();
    });

    it('discards a recording older than 7 days whatever the connection', async () => {
      const { deps } = makeDeps([owing(33)]);
      (deps.listPendingBackfills as jest.Mock).mockResolvedValue([33]);
      (deps.isOnline as jest.Mock).mockResolvedValue(false);
      (deps.recordingAgeMs as jest.Mock).mockResolvedValue(8 * DAY);

      await recoverOrphanedMeetings(deps);

      expect(deps.discardRecording).toHaveBeenCalledWith(33);
      expect(deps.resumeBackfill).not.toHaveBeenCalled();
    });

    it('reports a failed resume and goes on to the next note', async () => {
      const { deps } = makeDeps([owing(34), owing(35)]);
      (deps.listPendingBackfills as jest.Mock).mockResolvedValue([34, 35]);
      const failure = new Error('boom');
      (deps.resumeBackfill as jest.Mock).mockRejectedValueOnce(failure);

      await recoverOrphanedMeetings(deps);

      expect(deps.reportError).toHaveBeenCalledWith(failure, 34);
      expect(deps.resumeBackfill).toHaveBeenCalledWith(35);
    });
  });

  it('removes a sidecar whose recording or note is gone', async () => {
    const { deps } = makeDeps([note({ id: 40, transcriptionStatus: 'done' })]);
    (deps.listPendingBackfills as jest.Mock).mockResolvedValue([40, 41]);
    (deps.recordingExists as jest.Mock).mockResolvedValue(false);

    await recoverOrphanedMeetings(deps);

    expect(deps.deletePendingBackfill).toHaveBeenCalledWith(40);
    expect(deps.deletePendingBackfill).toHaveBeenCalledWith(41);
    expect(deps.resumeBackfill).not.toHaveBeenCalled();
  });

  it('discards a leftover recording relinked to a done note with a transcript', async () => {
    const { deps } = makeDeps([
      note({ id: 50, transcriptionStatus: 'done' }),
      note({ id: 51, transcriptionStatus: 'done' }),
      note({ id: 52, transcriptionStatus: 'done' }),
    ]);
    (deps.wasRelinked as jest.Mock).mockImplementation((id: number) => id !== 52);
    (deps.hasTranscript as jest.Mock).mockImplementation((id: number) => id !== 51);

    await recoverOrphanedMeetings(deps);

    expect((deps.discardRecording as jest.Mock).mock.calls).toEqual([[50]]);
  });

  it('keeps going when one note throws', async () => {
    const { deps } = makeDeps([
      note({ id: 60, transcriptionStatus: 'failed' }),
      note({ id: 61, transcriptionStatus: 'failed' }),
    ]);
    (deps.recordingAgeMs as jest.Mock)
      .mockRejectedValueOnce(new Error('stat'))
      .mockResolvedValueOnce(8 * DAY);
    (deps.listPendingBackfills as jest.Mock).mockRejectedValue(new Error('readdir'));

    await expect(recoverOrphanedMeetings(deps)).resolves.toBeUndefined();

    expect(deps.discardRecording).toHaveBeenCalledWith(61);
  });
});

interface FakeAppState {
  appState: { currentState: AppStateStatus; addEventListener: jest.Mock };
  remove: jest.Mock;
  emit: (state: AppStateStatus) => void;
}

function fakeAppState(currentState: AppStateStatus): FakeAppState {
  let listener: ((state: AppStateStatus) => void) | null = null;
  const remove = jest.fn(() => {
    listener = null;
  });
  const appState = {
    currentState,
    addEventListener: jest.fn((_type: 'change', next: (state: AppStateStatus) => void) => {
      listener = next;
      return { remove };
    }),
  };
  return { appState, remove, emit: (state: AppStateStatus) => listener?.(state) };
}

describe('waitForAppActive', () => {
  it('resolves at once without subscribing when already active', async () => {
    const { appState } = fakeAppState('active');
    await waitForAppActive(appState);
    expect(appState.addEventListener).not.toHaveBeenCalled();
  });

  it('waits past background and inactive, then unsubscribes', async () => {
    const { appState, remove, emit } = fakeAppState('background');
    let settled = false;
    const waiting = waitForAppActive(appState).then(() => {
      settled = true;
    });
    emit('inactive');
    emit('background');
    await Promise.resolve();
    expect(settled).toBe(false);
    emit('active');
    await waiting;
    expect(settled).toBe(true);
    expect(remove).toHaveBeenCalledTimes(1);
  });
});

describe('createdBeforeRuntime', () => {
  // 2026-09-25T10:00:00.500Z
  const runtimeStartedAtMs = Date.UTC(2026, 8, 25, 10, 0, 0, 500);

  it('keeps notes SQLite stamped before the runtime started', () => {
    expect(createdBeforeRuntime({ createdAt: '2026-09-25 09:59:59' }, runtimeStartedAtMs)).toBe(
      true,
    );
    expect(
      createdBeforeRuntime({ createdAt: '2026-09-24T22:00:00.000Z' }, runtimeStartedAtMs),
    ).toBe(true);
  });

  it('drops notes created during this runtime, including its first second', () => {
    expect(createdBeforeRuntime({ createdAt: '2026-09-25 10:00:00' }, runtimeStartedAtMs)).toBe(
      false,
    );
    expect(createdBeforeRuntime({ createdAt: '2026-09-25 10:05:00' }, runtimeStartedAtMs)).toBe(
      false,
    );
  });

  it('keeps a note with no creation stamp', () => {
    expect(createdBeforeRuntime({ createdAt: null }, runtimeStartedAtMs)).toBe(true);
  });

  it('keeps a note whose creation stamp cannot be parsed', () => {
    expect(createdBeforeRuntime({ createdAt: 'not a date' }, runtimeStartedAtMs)).toBe(true);
  });

  it('reads offset stamps instead of treating them as now', () => {
    expect(
      createdBeforeRuntime({ createdAt: '2026-09-25T09:59:59+00:00' }, runtimeStartedAtMs),
    ).toBe(true);
  });
});

describe('repairMeetingRecordings', () => {
  const run = async (files: string[], notes: Note[]) => {
    const deps = {
      listRecordingFiles: jest.fn(async () => files),
      getNote: jest.fn((id: number) => notes.find((candidate) => candidate.id === id) ?? null),
      recordingUri: (id: number) => `file:///docs/meeting-${id}.wav`,
      restorePath: jest.fn(),
      deleteFile: jest.fn(),
    };
    await repairMeetingRecordings(deps);
    return deps;
  };

  it('points a meeting whose path a sync erased back at its recording', async () => {
    const deps = await run(['meeting-4.wav'], [note({ id: 4, sourceFile: null })]);

    expect(deps.restorePath).toHaveBeenCalledWith(4, 'file:///docs/meeting-4.wav');
    expect(deps.deleteFile).not.toHaveBeenCalled();
  });

  it('deletes a recording whose note is gone for good', async () => {
    const deps = await run(['meeting-9.wav'], []);

    expect(deps.deleteFile).toHaveBeenCalledWith('file:///docs/meeting-9.wav');
    expect(deps.restorePath).not.toHaveBeenCalled();
  });

  it('returns the notes it pointed back at their recording', async () => {
    const deps = {
      listRecordingFiles: jest.fn(async () => ['meeting-4.wav', 'meeting-5.wav']),
      getNote: (id: number) => note(id === 4 ? { id, sourceFile: null } : { id }),
      recordingUri: (id: number) => `file:///docs/meeting-${id}.wav`,
      restorePath: jest.fn(),
      deleteFile: jest.fn(),
    };

    expect(await repairMeetingRecordings(deps)).toEqual([4]);
  });

  it('leaves the recording of a meeting still marked recording to recovery', async () => {
    const deps = await run(
      ['meeting-4.wav'],
      [note({ id: 4, transcriptionStatus: 'recording', sourceFile: null })],
    );

    expect(deps.restorePath).not.toHaveBeenCalled();
    expect(deps.deleteFile).not.toHaveBeenCalled();
  });

  it('leaves notes that still point somewhere, other note types, and other files alone', async () => {
    const deps = await run(
      ['meeting-4.wav', 'meeting-5.wav', 'SQLite', 'meeting-x.wav', 'meeting-6.wav.tmp'],
      [
        note({ id: 4 }),
        note({ id: 5, noteType: 'upload', sourceFile: null } as Partial<Note> & { id: number }),
      ],
    );

    expect(deps.restorePath).not.toHaveBeenCalled();
    expect(deps.deleteFile).not.toHaveBeenCalled();
  });
});
