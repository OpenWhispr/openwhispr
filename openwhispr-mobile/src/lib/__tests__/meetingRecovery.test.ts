jest.mock('expo-sqlite/localStorage/install', () => ({}));
jest.mock('expo-file-system/legacy', () => ({ documentDirectory: 'file:///docs/' }));
jest.mock('@/data', () => ({ notesRepository: { getAllNotes: jest.fn(() => []) } }));
jest.mock('@/store/useNotesStore', () => ({ useNotesStore: { getState: jest.fn() } }));
jest.mock('@/lib/sentry', () => ({ Sentry: { captureException: jest.fn() } }));
jest.mock('@/lib/captureLease', () => ({ isCaptureLeaseHeld: jest.fn(() => false) }));
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
  createForegroundBackfillResumer,
  createdBeforeRuntime,
  isFinishingLaunchRecovery,
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
    reopenAsFailed: jest.fn((id: number) => {
      calls.push(`reopenFailed:${id}`);
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
    listProcessedRecordings: jest.fn(() => []),
    owesBackfill: jest.fn(async () => false),
    readPendingBackfill: jest.fn(async () => [{ startMs: 0, endMs: 10_000 }]),
    recordingDurationMs: jest.fn(async () => 0),
    getSegmentTimes: jest.fn(() => []),
    savePendingBackfill: jest.fn(async (id: number) => {
      calls.push(`save:${id}`);
    }),
    isMeetingCapturing: jest.fn(() => false),
    awaitsConnection: jest.fn(async () => false),
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

  describe('audio the saved transcript does not hold', () => {
    const killedWithText = (id: number, harness: Harness): void => {
      (harness.deps.repairRecording as jest.Mock).mockResolvedValue(true);
      (harness.deps.hasTranscript as jest.Mock).mockReturnValue(true);
      (harness.deps.getSegmentTimes as jest.Mock).mockReturnValue([{ startMs: 0, endMs: 10_000 }]);
      (harness.deps.recordingDurationMs as jest.Mock).mockResolvedValue(60_000);
      (harness.deps.waitUntilActive as jest.Mock).mockImplementation(async () => {
        harness.calls.push('active');
      });
    };

    it('backfills the tail of a killed meeting before discarding its recording', async () => {
      const harness = makeDeps([killed(70)]);
      killedWithText(70, harness);

      await recoverOrphanedMeetings(harness.deps);

      expect(harness.deps.recordingDurationMs).toHaveBeenCalledWith('file:///docs/meeting-70.wav');
      expect(harness.deps.savePendingBackfill).toHaveBeenCalledWith(70, [
        { startMs: 10_000, endMs: 60_000 },
      ]);
      // The sidecar is written before the note is done: a done note without one loses its
      // recording to the launch clean-up, so a kill between the two would lose the tail.
      expect(harness.calls).toEqual([
        'link:70',
        'save:70',
        'keep:70',
        'active',
        'label:70',
        'backfill:70',
        'finish:70',
      ]);
      expect(harness.deps.discardRecording).not.toHaveBeenCalled();
    });

    it('keeps the recording and a sidecar for a killed meeting when offline', async () => {
      const harness = makeDeps([killed(71)]);
      killedWithText(71, harness);
      (harness.deps.isOnline as jest.Mock).mockResolvedValue(false);

      await recoverOrphanedMeetings(harness.deps);

      expect(harness.deps.savePendingBackfill).toHaveBeenCalledWith(71, [
        { startMs: 10_000, endMs: 60_000 },
      ]);
      expect(harness.deps.resumeBackfill).not.toHaveBeenCalled();
      expect(harness.deps.discardRecording).not.toHaveBeenCalled();
      expect(harness.deps.finishNotes).toHaveBeenCalledWith(71);
    });

    it('keeps the recording when what it owes cannot be saved', async () => {
      const harness = makeDeps([killed(72)]);
      killedWithText(72, harness);
      (harness.deps.savePendingBackfill as jest.Mock).mockRejectedValue(new Error('disk'));

      await recoverOrphanedMeetings(harness.deps);

      expect(harness.deps.discardRecording).not.toHaveBeenCalled();
      expect(harness.deps.finishNotes).toHaveBeenCalledWith(72);
    });

    it('removes the sidecar it wrote when the transcript cannot be kept', async () => {
      const harness = makeDeps([killed(76)]);
      killedWithText(76, harness);
      (harness.deps.keepTranscript as jest.Mock).mockImplementation(() => {
        throw new Error('cannot transition');
      });

      await recoverOrphanedMeetings(harness.deps);

      expect(harness.calls).toEqual(['link:76', 'save:76', 'clearSidecar:76', 'failed:76']);
      expect(harness.deps.finishNotes).not.toHaveBeenCalled();
    });

    it('keeps an earlier sidecar when the transcript cannot be kept', async () => {
      const harness = makeDeps([note({ id: 77, transcriptionStatus: 'transcribing' })]);
      killedWithText(77, harness);
      (harness.deps.listPendingBackfills as jest.Mock).mockResolvedValue([77]);
      (harness.deps.keepTranscript as jest.Mock).mockImplementation(() => {
        throw new Error('cannot transition');
      });

      await recoverOrphanedMeetings(harness.deps);

      expect(harness.deps.deletePendingBackfill).not.toHaveBeenCalled();
      expect(harness.deps.markFailed).toHaveBeenCalledWith(77);
    });

    it('does not derive owed windows twice', async () => {
      const harness = makeDeps([note({ id: 73, transcriptionStatus: 'transcribing' })]);
      killedWithText(73, harness);
      (harness.deps.listPendingBackfills as jest.Mock).mockResolvedValue([73]);

      await recoverOrphanedMeetings(harness.deps);

      expect(harness.deps.savePendingBackfill).not.toHaveBeenCalled();
      expect(harness.deps.resumeBackfill).toHaveBeenCalledWith(73);
    });

    it('keeps a done meeting recording whose sidecar cannot be read', async () => {
      const harness = makeDeps([note({ id: 74, transcriptionStatus: 'done' })]);
      (harness.deps.listPendingBackfills as jest.Mock).mockResolvedValue([74]);
      (harness.deps.readPendingBackfill as jest.Mock).mockResolvedValue(null);
      (harness.deps.getSegmentTimes as jest.Mock).mockReturnValue([
        { startMs: 30_000, endMs: 40_000 },
      ]);
      (harness.deps.recordingDurationMs as jest.Mock).mockResolvedValue(40_000);

      await recoverOrphanedMeetings(harness.deps);

      expect(harness.deps.savePendingBackfill).toHaveBeenCalledWith(74, [
        { startMs: 0, endMs: 30_000 },
      ]);
      expect(harness.deps.resumeBackfill).toHaveBeenCalledWith(74);
      expect(harness.deps.discardRecording).not.toHaveBeenCalled();
      expect(harness.deps.deletePendingBackfill).not.toHaveBeenCalled();
    });

    it('drops a sidecar that owes nothing, so the recording goes', async () => {
      const harness = makeDeps([note({ id: 75, transcriptionStatus: 'done' })]);
      const sidecars = new Set([75]);
      (harness.deps.listPendingBackfills as jest.Mock).mockResolvedValue([75]);
      (harness.deps.readPendingBackfill as jest.Mock).mockResolvedValue([]);
      (harness.deps.deletePendingBackfill as jest.Mock).mockImplementation(async (id: number) => {
        sidecars.delete(id);
      });
      (harness.deps.owesBackfill as jest.Mock).mockImplementation(async (id: number) =>
        sidecars.has(id),
      );
      (harness.deps.listProcessedRecordings as jest.Mock).mockReturnValue([
        { noteId: 75, uri: 'file:///docs/meeting-75.wav' },
      ]);
      // Pauses the transcript doesn't cover: an empty list still says nothing is owed.
      (harness.deps.getSegmentTimes as jest.Mock).mockReturnValue([{ startMs: 0, endMs: 10_000 }]);
      (harness.deps.recordingDurationMs as jest.Mock).mockResolvedValue(60_000);

      await recoverOrphanedMeetings(harness.deps);

      expect(harness.deps.deletePendingBackfill).toHaveBeenCalledWith(75);
      expect(harness.deps.savePendingBackfill).not.toHaveBeenCalled();
      expect(harness.deps.resumeBackfill).not.toHaveBeenCalled();
      expect(harness.deps.discardRecording).toHaveBeenCalledWith(75);
    });

    it('uploads nothing again for a meeting killed after its backfill finished', async () => {
      // Killed during the speaker pass: the list was emptied once every stretch was in.
      const harness = makeDeps([note({ id: 80, transcriptionStatus: 'diarizing' })]);
      killedWithText(80, harness);
      (harness.deps.listPendingBackfills as jest.Mock).mockResolvedValue([80]);
      (harness.deps.readPendingBackfill as jest.Mock).mockResolvedValue([]);

      await recoverOrphanedMeetings(harness.deps);

      expect(harness.calls).toEqual([
        'keep:80',
        'clearSidecar:80',
        'active',
        'label:80',
        'discard:80',
        'finish:80',
      ]);
      expect(harness.deps.savePendingBackfill).not.toHaveBeenCalled();
      expect(harness.deps.resumeBackfill).not.toHaveBeenCalled();
    });

    it('never derives or uploads audio for a relinked leftover with no sidecar', async () => {
      // Nothing marks this done note as a cloud meeting: it may have been recorded on-device,
      // whose audio must never go to the cloud.
      const harness = makeDeps([note({ id: 76, transcriptionStatus: 'done' })]);
      (harness.deps.wasRelinked as jest.Mock).mockReturnValue(true);
      (harness.deps.hasTranscript as jest.Mock).mockReturnValue(true);
      (harness.deps.getSegmentTimes as jest.Mock).mockReturnValue([{ startMs: 0, endMs: 10_000 }]);
      (harness.deps.recordingDurationMs as jest.Mock).mockResolvedValue(60_000);

      await recoverOrphanedMeetings(harness.deps);

      expect(harness.deps.recordingDurationMs).not.toHaveBeenCalled();
      expect(harness.deps.savePendingBackfill).not.toHaveBeenCalled();
      expect(harness.deps.resumeBackfill).not.toHaveBeenCalled();
      expect(harness.deps.discardRecording).toHaveBeenCalledWith(76);
    });

    it('keeps the recording of a killed meeting whose length cannot be read', async () => {
      const harness = makeDeps([killed(78)]);
      killedWithText(78, harness);
      (harness.deps.recordingDurationMs as jest.Mock).mockResolvedValue(null);

      await recoverOrphanedMeetings(harness.deps);

      // Unknown is not empty: nothing is derived and nothing is deleted.
      expect(harness.deps.savePendingBackfill).not.toHaveBeenCalled();
      expect(harness.deps.discardRecording).not.toHaveBeenCalled();
      expect(harness.deps.finishNotes).toHaveBeenCalledWith(78);
    });

    it('keeps a done recording and its unreadable sidecar when the length cannot be read', async () => {
      const harness = makeDeps([note({ id: 79, transcriptionStatus: 'done' })]);
      (harness.deps.listPendingBackfills as jest.Mock).mockResolvedValue([79]);
      (harness.deps.readPendingBackfill as jest.Mock).mockResolvedValue(null);
      (harness.deps.recordingDurationMs as jest.Mock).mockResolvedValue(null);

      await recoverOrphanedMeetings(harness.deps);

      expect(harness.deps.deletePendingBackfill).not.toHaveBeenCalled();
      expect(harness.deps.discardRecording).not.toHaveBeenCalled();
    });
  });

  it('skips a stale discard when the note is no longer settled', async () => {
    const harness = makeDeps([note({ id: 77, transcriptionStatus: 'failed' })]);
    (harness.deps.recordingAgeMs as jest.Mock).mockResolvedValue(8 * DAY);
    (harness.deps.getNote as jest.Mock).mockReturnValue(
      note({ id: 77, transcriptionStatus: 'transcribing' }),
    );

    await recoverOrphanedMeetings(harness.deps);

    expect(harness.deps.discardRecording).not.toHaveBeenCalled();
  });

  describe('a meeting waiting for the connection', () => {
    const waitingNote = (id: number): Note => note({ id, transcriptionStatus: 'failed' });
    const markWaiting = (deps: MeetingRecoveryDeps, ids: number[]): void => {
      (deps.listPendingBackfills as jest.Mock).mockResolvedValue(ids);
      (deps.awaitsConnection as jest.Mock).mockImplementation(async (id: number) =>
        ids.includes(id),
      );
    };

    it('transcribes it once the app is active and online, through its mark', async () => {
      const { deps, calls } = makeDeps([waitingNote(40)]);
      markWaiting(deps, [40]);
      (deps.waitUntilActive as jest.Mock).mockImplementation(async () => {
        calls.push('active');
      });

      await recoverOrphanedMeetings(deps);

      expect(calls).toEqual(['active', 'backfill:40']);
      expect(deps.resume).not.toHaveBeenCalled();
      expect(deps.discardRecording).not.toHaveBeenCalled();
      expect(deps.deletePendingBackfill).not.toHaveBeenCalled();
    });

    it('leaves it waiting offline, with its recording', async () => {
      const { deps } = makeDeps([waitingNote(41)]);
      markWaiting(deps, [41]);
      (deps.isOnline as jest.Mock).mockResolvedValue(false);

      await recoverOrphanedMeetings(deps);

      expect(deps.resumeBackfill).not.toHaveBeenCalled();
      expect(deps.discardRecording).not.toHaveBeenCalled();
    });

    it('leaves a plain failed meeting to its Retry', async () => {
      const { deps } = makeDeps([waitingNote(42)]);
      (deps.listPendingBackfills as jest.Mock).mockResolvedValue([42]);

      await recoverOrphanedMeetings(deps);

      expect(deps.resumeBackfill).not.toHaveBeenCalled();
    });

    it('still deletes a recording older than 7 days', async () => {
      const { deps } = makeDeps([waitingNote(43)]);
      markWaiting(deps, [43]);
      (deps.recordingAgeMs as jest.Mock).mockResolvedValue(8 * DAY);

      await recoverOrphanedMeetings(deps);

      expect(deps.discardRecording).toHaveBeenCalledWith(43);
      expect(deps.resumeBackfill).not.toHaveBeenCalled();
    });

    it('resumes one killed mid-upload through its mark, not a plain Retry', async () => {
      const { deps, calls } = makeDeps([note({ id: 44, transcriptionStatus: 'transcribing' })]);
      markWaiting(deps, [44]);

      await recoverOrphanedMeetings(deps);

      // The mark keeps the account it may go up under and its backoff; Retry would use neither.
      expect(calls).toEqual(['failed:44', 'backfill:44']);
      expect(deps.resume).not.toHaveBeenCalled();
    });

    it('leaves one killed mid-upload waiting when offline', async () => {
      const { deps, calls } = makeDeps([note({ id: 45, transcriptionStatus: 'transcribing' })]);
      markWaiting(deps, [45]);
      (deps.isOnline as jest.Mock).mockResolvedValue(false);

      await recoverOrphanedMeetings(deps);

      expect(calls).toEqual(['failed:45']);
    });
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

  it('reopens a relinked done note with no transcript as failed, keeping its recording', async () => {
    // Its audio was never transcribed (Stop before the session existed, or a writer that
    // failed): the recording is the only copy, so the note gets Retry instead of a delete.
    const notes = [note({ id: 53, transcriptionStatus: 'done' })];
    const { deps, calls } = makeDeps(notes);
    (deps.wasRelinked as jest.Mock).mockReturnValue(true);
    (deps.reopenAsFailed as jest.Mock).mockImplementation((id: number) => {
      calls.push(`reopenFailed:${id}`);
      notes[0] = note({ id, transcriptionStatus: 'failed' });
    });
    // As in production, the processed list is read after the sweep.
    (deps.listProcessedRecordings as jest.Mock).mockImplementation(() =>
      notes
        .filter((candidate) => candidate.transcriptionStatus === 'done')
        .map((candidate) => ({
          noteId: candidate.id,
          uri: `file:///docs/meeting-${candidate.id}.wav`,
        })),
    );

    await recoverOrphanedMeetings(deps);

    expect(calls).toEqual(['reopenFailed:53']);
    expect(deps.discardRecording).not.toHaveBeenCalled();
    expect(deps.resumeBackfill).not.toHaveBeenCalled();
  });

  it('leaves settled backfills while a meeting is being captured', async () => {
    const { deps } = makeDeps([
      note({ id: 55, transcriptionStatus: 'done' }),
      note({ id: 56, transcriptionStatus: 'done' }),
    ]);
    (deps.listPendingBackfills as jest.Mock).mockResolvedValue([55, 56]);
    (deps.isMeetingCapturing as jest.Mock).mockReturnValue(true);

    await recoverOrphanedMeetings(deps);

    expect(deps.resumeBackfill).not.toHaveBeenCalled();
    expect(deps.discardRecording).not.toHaveBeenCalled();
  });

  it('stops the settled backfills before the next note once a meeting starts', async () => {
    const { deps } = makeDeps([
      note({ id: 57, transcriptionStatus: 'done' }),
      note({ id: 58, transcriptionStatus: 'done' }),
    ]);
    (deps.listPendingBackfills as jest.Mock).mockResolvedValue([57, 58]);
    (deps.resumeBackfill as jest.Mock).mockImplementation(async () => {
      (deps.isMeetingCapturing as jest.Mock).mockReturnValue(true);
    });

    await recoverOrphanedMeetings(deps);

    expect((deps.resumeBackfill as jest.Mock).mock.calls).toEqual([[57]]);
  });

  it('waits for the app to be active before resuming a settled backfill', async () => {
    const { deps, calls } = makeDeps([note({ id: 54, transcriptionStatus: 'done' })]);
    (deps.listPendingBackfills as jest.Mock).mockResolvedValue([54]);
    (deps.waitUntilActive as jest.Mock).mockImplementation(async () => {
      calls.push('active');
    });

    await recoverOrphanedMeetings(deps);

    expect(calls).toEqual(['active', 'backfill:54']);
  });

  describe('recordings left on finished meetings', () => {
    const processed = (...ids: number[]): { noteId: number; uri: string }[] =>
      ids.map((noteId) => ({ noteId, uri: `file:///docs/meeting-${noteId}.wav` }));

    it('discards recordings left on finished meetings by earlier versions', async () => {
      const { deps } = makeDeps([
        note({ id: 70, transcriptionStatus: 'done', diarizationEnabled: 1 }),
        note({ id: 71, transcriptionStatus: 'done', diarizationEnabled: 1 }),
        note({ id: 72, transcriptionStatus: 'failed', diarizationEnabled: 1 }),
      ]);
      (deps.listProcessedRecordings as jest.Mock).mockReturnValue(processed(70, 71));

      await recoverOrphanedMeetings(deps);

      expect((deps.discardRecording as jest.Mock).mock.calls).toEqual([[70], [71]]);
    });

    it('keeps a recording that still owes audio and resumes it', async () => {
      const { deps, calls } = makeDeps([note({ id: 73, transcriptionStatus: 'done' })]);
      (deps.listPendingBackfills as jest.Mock).mockResolvedValue([73]);
      (deps.listProcessedRecordings as jest.Mock).mockReturnValue(processed(73));
      (deps.owesBackfill as jest.Mock).mockResolvedValue(true);

      await recoverOrphanedMeetings(deps);

      expect(calls).toEqual(['backfill:73']);
    });

    it('discards one whose sidecar holds nothing it can use', async () => {
      const { deps } = makeDeps([note({ id: 74, transcriptionStatus: 'done' })]);
      (deps.listPendingBackfills as jest.Mock).mockResolvedValue([74]);
      (deps.listProcessedRecordings as jest.Mock).mockReturnValue(processed(74));

      await recoverOrphanedMeetings(deps);

      expect(deps.owesBackfill).toHaveBeenCalledWith(74);
      expect(deps.discardRecording).toHaveBeenCalledWith(74);
    });

    it('runs after the sweep and before the orphans, and never on a note in flight', async () => {
      const { deps, calls } = makeDeps([
        note({ id: 75, transcriptionStatus: 'transcribing', diarizationEnabled: 1 }),
      ]);
      (deps.listProcessedRecordings as jest.Mock).mockImplementation(() => {
        calls.push('listProcessed');
        return [];
      });

      await recoverOrphanedMeetings(deps);

      expect(calls[0]).toBe('listProcessed');
      expect(deps.discardRecording).not.toHaveBeenCalled();
    });

    it('keeps going when one discard throws', async () => {
      const { deps } = makeDeps([]);
      (deps.listProcessedRecordings as jest.Mock).mockReturnValue(processed(76, 77));
      (deps.discardRecording as jest.Mock).mockRejectedValueOnce(new Error('rm'));

      await recoverOrphanedMeetings(deps);

      expect(deps.discardRecording).toHaveBeenCalledWith(77);
      expect(deps.reportError).toHaveBeenCalledWith(expect.any(Error), 76);
    });
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

describe('createForegroundBackfillResumer', () => {
  const makeResumer = (ids: number[] = [30]) => {
    const deps = {
      listPendingBackfills: jest.fn(async () => ids),
      isOnline: jest.fn(async () => true),
      resumeBackfill: jest.fn(async (_noteId: number): Promise<void> => undefined),
      reportError: jest.fn(),
      isMeetingCapturing: jest.fn(() => false),
    };
    return { deps, onChange: createForegroundBackfillResumer(deps) };
  };

  it('resumes owed backfills when the app comes back to the foreground online', async () => {
    const { deps, onChange } = makeResumer([30, 31]);

    onChange('background');
    onChange('active');
    await flushMicrotasks();

    expect((deps.resumeBackfill as jest.Mock).mock.calls).toEqual([[30], [31]]);
  });

  it('does nothing offline, or with nothing owed', async () => {
    const offline = makeResumer();
    offline.deps.isOnline.mockResolvedValue(false);
    offline.onChange('background');
    offline.onChange('active');
    const nothingOwed = makeResumer([]);
    nothingOwed.onChange('background');
    nothingOwed.onChange('active');
    await flushMicrotasks();

    expect(offline.deps.resumeBackfill).not.toHaveBeenCalled();
    expect(nothingOwed.deps.isOnline).not.toHaveBeenCalled();
    expect(nothingOwed.deps.resumeBackfill).not.toHaveBeenCalled();
  });

  it('runs once per return from the background, not on every active state', async () => {
    const { deps, onChange } = makeResumer();

    onChange('active'); // never left: launch recovery covers a cold start
    onChange('inactive'); // Control Centre, a system alert
    onChange('active');
    await flushMicrotasks();
    expect(deps.resumeBackfill).not.toHaveBeenCalled();

    onChange('background');
    onChange('inactive');
    onChange('active');
    onChange('inactive');
    onChange('active');
    await flushMicrotasks();
    expect(deps.resumeBackfill).toHaveBeenCalledTimes(1);
  });

  it('runs one pass at a time', async () => {
    const { deps, onChange } = makeResumer();
    let release: () => void = () => undefined;
    deps.resumeBackfill.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );

    onChange('background');
    onChange('active');
    await flushMicrotasks();
    onChange('background');
    onChange('active');
    await flushMicrotasks();
    expect(deps.resumeBackfill).toHaveBeenCalledTimes(1);

    release();
    await flushMicrotasks();
    onChange('background');
    onChange('active');
    await flushMicrotasks();
    expect(deps.resumeBackfill).toHaveBeenCalledTimes(2);
  });

  it('uploads nothing while a meeting is being captured', async () => {
    const { deps, onChange } = makeResumer([30, 31]);
    deps.isMeetingCapturing.mockReturnValue(true);

    onChange('background');
    onChange('active');
    await flushMicrotasks();

    expect(deps.resumeBackfill).not.toHaveBeenCalled();
  });

  it('stops before the next note once a meeting starts', async () => {
    const { deps, onChange } = makeResumer([30, 31]);
    deps.resumeBackfill.mockImplementation(async () => {
      deps.isMeetingCapturing.mockReturnValue(true);
    });

    onChange('background');
    onChange('active');
    await flushMicrotasks();

    expect((deps.resumeBackfill as jest.Mock).mock.calls).toEqual([[30]]);
  });

  describe('when the connection comes back', () => {
    const makeNetworkResumer = (active = true) => {
      const deps = {
        listPendingBackfills: jest.fn(async () => [30]),
        isOnline: jest.fn(async () => true),
        resumeBackfill: jest.fn(async (_noteId: number): Promise<void> => undefined),
        reportError: jest.fn(),
        isMeetingCapturing: jest.fn(() => false),
        isAppActive: jest.fn(() => active),
      };
      return { deps, resumer: createForegroundBackfillResumer(deps) };
    };

    it('resumes owed work when the phone comes back online in the foreground', async () => {
      const { deps, resumer } = makeNetworkResumer();

      resumer.onNetworkChange(false);
      resumer.onNetworkChange(true);
      await flushMicrotasks();

      expect(deps.resumeBackfill).toHaveBeenCalledWith(30);
    });

    it('does nothing for an update that was never offline, or one that is offline', async () => {
      const { deps, resumer } = makeNetworkResumer();

      resumer.onNetworkChange(true);
      resumer.onNetworkChange(true);
      resumer.onNetworkChange(false);
      await flushMicrotasks();

      expect(deps.resumeBackfill).not.toHaveBeenCalled();
    });

    it('waits for the foreground: a return to the app runs it then', async () => {
      const { deps, resumer } = makeNetworkResumer(false);

      resumer.onNetworkChange(false);
      resumer.onNetworkChange(true);
      await flushMicrotasks();
      expect(deps.resumeBackfill).not.toHaveBeenCalled();

      resumer('background');
      resumer('active');
      await flushMicrotasks();
      expect(deps.resumeBackfill).toHaveBeenCalledTimes(1);
    });

    it('shares one pass with a return to the foreground', async () => {
      const { deps, resumer } = makeNetworkResumer();
      let release: () => void = () => undefined;
      deps.resumeBackfill.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );

      resumer('background');
      resumer('active');
      await flushMicrotasks();
      resumer.onNetworkChange(false);
      resumer.onNetworkChange(true);
      await flushMicrotasks();
      expect(deps.resumeBackfill).toHaveBeenCalledTimes(1);
      release();
      await flushMicrotasks();
    });
  });

  it('reports a failed resume and goes on', async () => {
    const { deps, onChange } = makeResumer([30, 31]);
    const failure = new Error('boom');
    deps.resumeBackfill.mockRejectedValueOnce(failure);
    deps.listPendingBackfills.mockResolvedValueOnce([30, 31]);

    onChange('background');
    onChange('active');
    await flushMicrotasks();

    expect(deps.reportError).toHaveBeenCalledWith(failure, 30);
    expect(deps.resumeBackfill).toHaveBeenCalledWith(31);

    deps.listPendingBackfills.mockRejectedValueOnce(new Error('readdir'));
    onChange('background');
    onChange('active');
    await flushMicrotasks();
    expect(deps.reportError).toHaveBeenCalledTimes(2);
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

  it('deletes the recording of a note in the trash instead of linking it', async () => {
    const deps = await run(
      ['meeting-4.wav', 'meeting-5.wav'],
      [
        note({ id: 4, sourceFile: null, deletedAt: '2026-11-24 10:00:00' }),
        note({ id: 5, deletedAt: '2026-11-24 10:00:00' }),
      ],
    );

    expect((deps.deleteFile as jest.Mock).mock.calls).toEqual([
      ['file:///docs/meeting-4.wav'],
      ['file:///docs/meeting-5.wav'],
    ]);
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

describe('launch recovery and the foreground resume', () => {
  const killedWithTranscript = (id: number): Harness => {
    const harness = makeDeps([note({ id, transcriptionStatus: 'recording', sourceFile: null })]);
    (harness.deps.repairRecording as jest.Mock).mockResolvedValue(true);
    (harness.deps.hasTranscript as jest.Mock).mockReturnValue(true);
    (harness.deps.getSegmentTimes as jest.Mock).mockReturnValue([{ startMs: 0, endMs: 10_000 }]);
    (harness.deps.recordingDurationMs as jest.Mock).mockResolvedValue(60_000);
    return harness;
  };

  it('does not resume a note launch recovery is still finishing', async () => {
    const harness = killedWithTranscript(80);
    let becomeActive: () => void = () => undefined;
    (harness.deps.waitUntilActive as jest.Mock).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          becomeActive = resolve;
        }),
    );
    const foreground = {
      listPendingBackfills: jest.fn(async () => [80, 81]),
      isOnline: jest.fn(async () => true),
      resumeBackfill: jest.fn(async (id: number): Promise<void> => {
        harness.calls.push(`foreground:${id}`);
      }),
      reportError: jest.fn(),
      isMeetingCapturing: jest.fn(() => false),
    };
    const onChange = createForegroundBackfillResumer(foreground);

    const recovery = recoverOrphanedMeetings(harness.deps);
    await flushMicrotasks();
    expect(isFinishingLaunchRecovery(80)).toBe(true);

    // The return to the foreground arrives while recovery waits to label the speakers.
    onChange('background');
    onChange('active');
    await flushMicrotasks();
    expect(foreground.resumeBackfill.mock.calls).toEqual([[81]]);

    becomeActive();
    await recovery;

    expect(isFinishingLaunchRecovery(80)).toBe(false);
    expect(harness.calls.slice(harness.calls.indexOf('foreground:81') + 1)).toEqual([
      'label:80',
      'backfill:80',
      'finish:80',
    ]);
  });

  it('lets the foreground resume a note again once its recovery throws', async () => {
    const harness = killedWithTranscript(82);
    const failure = new Error('wait');
    (harness.deps.waitUntilActive as jest.Mock).mockRejectedValue(failure);

    await recoverOrphanedMeetings(harness.deps);

    expect(harness.deps.reportError).toHaveBeenCalledWith(failure, 82);
    expect(harness.deps.labelSpeakers).not.toHaveBeenCalled();
    expect(isFinishingLaunchRecovery(82)).toBe(false);
  });
});
