jest.mock('expo-sqlite/localStorage/install', () => ({}));
jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///docs/',
  getInfoAsync: jest.fn(),
  deleteAsync: jest.fn(async () => undefined),
  readDirectoryAsync: jest.fn(async () => []),
}));
// The app's repository opens expo-sqlite at import; these tests pass an in-memory one.
jest.mock('@/data', () => ({ notesRepository: {} }));
jest.mock('@/store/useNotesStore', () => ({ useNotesStore: { getState: jest.fn() } }));
jest.mock('@/lib/sentry', () => ({ Sentry: { captureMessage: jest.fn() } }));
jest.mock('@/lib/captureLease', () => ({ isCaptureLeaseHeld: jest.fn(() => false) }));
jest.mock('expo-network', () => ({ getNetworkStateAsync: jest.fn() }));
jest.mock('../../../modules/live-pcm-streaming/src', () => ({
  LivePCMStreaming: { repairRecording: jest.fn() },
}));

import { eq } from 'drizzle-orm';
import * as FileSystem from 'expo-file-system/legacy';
import { notes } from '@/db/schema';
import { createMemoryRepository } from '@/data/local/__tests__/testDb';
import { useNotesStore } from '@/store/useNotesStore';
import {
  createMeetingRecordingRepairDeps,
  createMeetingRecoveryDeps,
  recoverOrphanedMeetings,
} from '@/lib/meetingRecovery';

// expo-sqlite installs it in the app; jest has no global localStorage.
const storage = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  },
});

const RUNTIME_STARTED_AT_MS = Date.parse('2026-11-24T10:00:00Z');
const BEFORE_RUNTIME = '2026-11-24T09:00:00Z';
const getInfo = FileSystem.getInfoAsync as jest.Mock;
const deleteFile = FileSystem.deleteAsync as jest.Mock;
const wav = (id: number): string => `file:///docs/meeting-${id}.wav`;
const sidecar = (id: number): string => `file:///docs/meeting-${id}.backfill.json`;

const setUp = () => {
  const { repo, db } = createMemoryRepository();
  const seed = (fields: {
    status: string;
    noteType?: string;
    createdAt?: string;
    sourceFile?: (id: number) => string | null;
  }): number => {
    const { id } = repo.createNote('Meeting', '');
    db.update(notes)
      .set({
        noteType: fields.noteType ?? 'meeting',
        transcriptionStatus: fields.status,
        sourceFile: (fields.sourceFile ?? wav)(id),
        createdAt: fields.createdAt ?? BEFORE_RUNTIME,
      })
      .where(eq(notes.id, id))
      .run();
    return id;
  };
  const deps = createMeetingRecoveryDeps({
    repository: repo,
    directory: 'file:///docs/',
    runtimeStartedAtMs: RUNTIME_STARTED_AT_MS,
    relinked: new Set(),
  });
  return { repo, seed, deps };
};

beforeEach(() => {
  jest.clearAllMocks();
  getInfo.mockResolvedValue({ exists: false });
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('createMeetingRecoveryDeps', () => {
  describe('listProcessedRecordings', () => {
    it('lists only done meetings from before this runtime that link their managed recording', () => {
      const { seed, deps } = setUp();
      const listed = seed({ status: 'done' });
      for (const status of ['recording', 'transcribing', 'diarizing', 'failed', 'idle']) {
        seed({ status });
      }
      seed({ status: 'done', createdAt: '2026-11-24T10:00:00Z' }); // created in this runtime
      seed({ status: 'done', noteType: 'personal' });
      seed({ status: 'done', sourceFile: () => null });
      seed({ status: 'done', sourceFile: () => 'file:///docs/meeting-999.wav' });
      seed({ status: 'done', sourceFile: (id) => `file:///elsewhere/meeting-${id}.wav` });

      expect(deps.listProcessedRecordings()).toEqual([{ noteId: listed, uri: wav(listed) }]);
    });

    it('never discards a listed recording whose sidecar file exists', async () => {
      const { seed, deps } = setUp();
      const processed = seed({ status: 'done' });
      const owing = seed({ status: 'done' });
      const discard = jest.fn(async (): Promise<void> => undefined);
      (useNotesStore.getState as jest.Mock).mockReturnValue({ discardMeetingRecording: discard });
      // A sidecar the directory listing missed still holds the recording back.
      getInfo.mockImplementation(async (uri: string) => ({ exists: uri === sidecar(owing) }));

      await recoverOrphanedMeetings(deps);

      expect(discard.mock.calls).toEqual([[processed]]);
    });
  });

  describe('owesBackfill', () => {
    it('reads whether the sidecar file exists, counting a failed read as there', async () => {
      const { deps } = setUp();
      getInfo.mockResolvedValueOnce({ exists: true });
      await expect(deps.owesBackfill(4)).resolves.toBe(true);
      expect(getInfo).toHaveBeenLastCalledWith(sidecar(4));
      getInfo.mockResolvedValueOnce({ exists: false });
      await expect(deps.owesBackfill(4)).resolves.toBe(false);
      getInfo.mockRejectedValueOnce(new Error('io'));
      await expect(deps.owesBackfill(4)).resolves.toBe(true);
    });
  });

  describe('recordingAgeMs', () => {
    it("converts the file's modification time from seconds to an age in ms", async () => {
      const { deps } = setUp();
      jest.spyOn(Date, 'now').mockReturnValue(5_000_000);
      getInfo.mockResolvedValueOnce({ exists: true, modificationTime: 1_000 });

      await expect(deps.recordingAgeMs(wav(3))).resolves.toBe(4_000_000);
      expect(getInfo).toHaveBeenLastCalledWith(wav(3));
    });

    it('is null when the file is missing or its modification time is unknown', async () => {
      const { deps } = setUp();
      getInfo.mockResolvedValueOnce({ exists: false });
      await expect(deps.recordingAgeMs(wav(3))).resolves.toBeNull();
      getInfo.mockResolvedValueOnce({ exists: true });
      await expect(deps.recordingAgeMs(wav(3))).resolves.toBeNull();
    });
  });

  describe('recordingExists', () => {
    it('counts a failed read as there, so a sidecar is never dropped on it', async () => {
      const { deps } = setUp();
      getInfo.mockRejectedValueOnce(new Error('io'));
      await expect(deps.recordingExists(3)).resolves.toBe(true);
      getInfo.mockResolvedValueOnce({ exists: false });
      await expect(deps.recordingExists(3)).resolves.toBe(false);
      expect(getInfo).toHaveBeenLastCalledWith(wav(3));
    });
  });

  describe('deletePendingBackfill', () => {
    it('deletes only the sidecar', async () => {
      const { deps } = setUp();
      await deps.deletePendingBackfill(3);
      expect(deleteFile.mock.calls).toEqual([[sidecar(3), { idempotent: true }]]);
    });
  });
});

describe('createMeetingRecordingRepairDeps', () => {
  it('deletes a recording together with its sidecar', async () => {
    const { repo } = setUp();
    createMeetingRecordingRepairDeps('file:///docs/', repo).deleteFile(wav(7));
    await new Promise((resolve) => setImmediate(resolve));

    expect(deleteFile.mock.calls).toEqual([
      [wav(7), { idempotent: true }],
      [sidecar(7), { idempotent: true }],
    ]);
  });

  it('clears no sidecar for a file that is not a meeting recording', async () => {
    const { repo } = setUp();
    createMeetingRecordingRepairDeps('file:///docs/', repo).deleteFile('file:///docs/other.wav');
    await new Promise((resolve) => setImmediate(resolve));

    expect(deleteFile.mock.calls).toEqual([['file:///docs/other.wav', { idempotent: true }]]);
  });

  it('points a note back at its recording', () => {
    const { repo, seed } = setUp();
    const id = seed({ status: 'done', sourceFile: () => null });
    createMeetingRecordingRepairDeps('file:///docs/', repo).restorePath(id, wav(id));

    expect(repo.getNoteById(id)?.sourceFile).toBe(wav(id));
  });
});
