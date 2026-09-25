jest.mock('expo-sqlite/localStorage/install', () => ({}));
jest.mock('@/data', () => ({ notesRepository: { getAllNotes: jest.fn(() => []) } }));
jest.mock('@/store/useNotesStore', () => ({ useNotesStore: { getState: jest.fn() } }));
jest.mock('@/lib/sentry', () => ({ Sentry: { captureException: jest.fn() } }));
jest.mock('@/lib/transcriptAudio', () => ({
  isManagedMeetingAudioUri: (noteId: number, uri?: string | null) =>
    uri === `file:///docs/meeting-${noteId}.wav`,
}));

import type { AppStateStatus } from 'react-native';
import type { Note } from '@/data';
import {
  MEETING_RESUME_MARKER_PREFIX,
  createdBeforeRuntime,
  recoverOrphanedMeetings,
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
  };
  return { deps, store, calls };
}

const marker = (id: number): string => `${MEETING_RESUME_MARKER_PREFIX}${id}`;

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
    await Promise.resolve();
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
    await Promise.resolve();
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
