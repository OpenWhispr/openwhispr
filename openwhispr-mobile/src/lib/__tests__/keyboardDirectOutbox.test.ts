import { drainKeyboardDirectOutbox, type OutboxDeps } from '@/lib/keyboardDirectOutbox';

jest.mock('expo-file-system/legacy', () => ({}));
jest.mock('react-native', () => ({ AppState: { addEventListener: () => ({ remove: () => {} }) } }));
jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: { getState: () => ({}), subscribe: () => () => {} },
}));
jest.mock('@/store/useProcessingModeStore', () => ({
  useProcessingModeStore: { getState: () => ({}) },
}));
jest.mock('@/store/useTranscriptStore', () => ({ useTranscriptStore: { getState: () => ({}) } }));
jest.mock('@/lib/productEvents', () => ({
  captureDictationContext: jest.fn(),
  recordDictationCompleted: jest.fn(),
}));
jest.mock('../../../modules/app-group-storage/src', () => ({ AppGroupStorage: {} }));

const NOW = Date.parse('2026-11-20T12:00:00.000Z');
const MINUTE = 60_000;

function record(overrides: Record<string, unknown> = {}) {
  return {
    jobId: 'job-1',
    status: 'completed',
    userId: 'u1',
    startedAtMs: NOW - 30 * MINUTE,
    completedAtMs: NOW - 29 * MINUTE,
    durationMs: 4_000,
    tone: 'formal',
    text: 'Send it to a@b.co.',
    originalText: 'send it to my email',
    cleanupApplied: true,
    ...overrides,
  };
}

function harness(
  files: Record<string, string>,
  options: { userId?: string | null; history?: string[]; wrapFails?: boolean } = {},
) {
  const disk = { ...files };
  const added: unknown[] = [];
  const failed: unknown[] = [];
  const events: unknown[] = [];
  const deps: OutboxDeps = {
    files: {
      list: async () => Object.keys(disk),
      read: async (name) => disk[name] ?? null,
      exists: async (name) => name in disk,
      remove: async (name) => {
        delete disk[name];
      },
      uri: (name) => `file:///group/direct-dictations/${name}`,
    },
    now: () => NOW,
    userId: () => (options.userId === undefined ? 'u1' : options.userId),
    hasTranscript: async (jobId) => (options.history ?? []).includes(jobId),
    addTranscript: async (input) => {
      added.push(input);
    },
    addFailedTranscript: async (input) => {
      failed.push(input);
    },
    recordCompleted: (input) => {
      events.push(input);
    },
    wrapPcmAsWav: async (pcmName, wavName) => {
      if (options.wrapFails || !(pcmName in disk)) return false;
      disk[wavName] = `wav(${disk[pcmName]})`;
      return true;
    },
  };
  return { disk, added, failed, events, deps };
}

describe('drainKeyboardDirectOutbox', () => {
  it('turns a completed dictation into a History row and a counted event, dated when it finished', async () => {
    const h = harness({ 'job-1.json': JSON.stringify(record()) });
    const result = await drainKeyboardDirectOutbox(h.deps);
    expect(result).toEqual({ completed: 1, failed: 0, dropped: 0 });
    expect(h.added).toEqual([
      {
        id: 'job-1',
        jobId: 'job-1',
        text: 'Send it to a@b.co.',
        originalText: 'send it to my email',
        provider: 'cloud',
        requestContext: 'keyboard',
        keyboardTone: 'formal',
        duration: 4,
        createdAt: NOW - 29 * MINUTE,
      },
    ]);
    expect(h.events).toEqual([{ captureId: 'job-1', words: 5, occurredAt: NOW - 29 * MINUTE }]);
    expect(h.disk).toEqual({});
  });

  it('adds nothing twice', async () => {
    const h = harness({ 'job-1.json': JSON.stringify(record()) }, { history: ['job-1'] });
    await drainKeyboardDirectOutbox(h.deps);
    expect(h.added).toEqual([]);
    expect(h.events).toEqual([]);
    expect(h.disk).toEqual({});
  });

  it("drops another account's dictations with their audio", async () => {
    const h = harness({
      'job-1.json': JSON.stringify(record({ userId: 'u2', status: 'failed' })),
      'job-1.m4a': 'audio',
    });
    expect(await drainKeyboardDirectOutbox(h.deps)).toEqual({
      completed: 0,
      failed: 0,
      dropped: 1,
    });
    expect(h.added).toEqual([]);
    expect(h.failed).toEqual([]);
    expect(h.disk).toEqual({});
  });

  it('reads and deletes nothing when nobody is signed in', async () => {
    const h = harness({ 'job-1.json': JSON.stringify(record()) }, { userId: null });
    expect(await drainKeyboardDirectOutbox(h.deps)).toEqual({
      completed: 0,
      failed: 0,
      dropped: 0,
    });
    expect(Object.keys(h.disk)).toEqual(['job-1.json']);
  });

  it('turns a failed dictation into a retryable row that takes its audio', async () => {
    const h = harness({
      'job-1.json': JSON.stringify(record({ status: 'failed', text: null, originalText: null })),
      'job-1.m4a': 'audio',
    });
    expect(await drainKeyboardDirectOutbox(h.deps)).toEqual({
      completed: 0,
      failed: 1,
      dropped: 0,
    });
    expect(h.failed).toEqual([
      {
        id: 'job-1',
        jobId: 'job-1',
        audioUrl: 'file:///group/direct-dictations/job-1.m4a',
        audioFileName: 'job-1.m4a',
        audioMimeType: 'audio/mp4',
        duration: 4,
        provider: 'cloud',
        requestContext: 'keyboard',
        keyboardTone: 'formal',
        errorMessage: "Couldn't transcribe. Tap to retry.",
        createdAt: NOW - 30 * MINUTE,
      },
    ]);
    expect(h.disk).toEqual({ 'job-1.m4a': 'audio' });
  });

  it('leaves a recent pending dictation to the keyboard', async () => {
    const files = {
      'job-1.json': JSON.stringify(record({ status: 'pending', startedAtMs: NOW - 5 * MINUTE })),
      'job-1.m4a': 'audio',
    };
    const h = harness(files);
    expect(await drainKeyboardDirectOutbox(h.deps)).toEqual({
      completed: 0,
      failed: 0,
      dropped: 0,
    });
    expect(h.disk).toEqual(files);
  });

  it('treats a pending dictation older than 10 minutes as failed', async () => {
    const h = harness({
      'job-1.json': JSON.stringify(record({ status: 'pending', startedAtMs: NOW - 11 * MINUTE })),
      'job-1.m4a': 'audio',
    });
    expect(await drainKeyboardDirectOutbox(h.deps)).toEqual({
      completed: 0,
      failed: 1,
      dropped: 0,
    });
    expect(h.failed).toHaveLength(1);
  });

  it('skips and keeps a record it cannot read', async () => {
    const h = harness({ 'broken.json': '{' });
    expect(await drainKeyboardDirectOutbox(h.deps)).toEqual({
      completed: 0,
      failed: 0,
      dropped: 0,
    });
    expect(Object.keys(h.disk)).toEqual(['broken.json']);
  });

  it('leaves audio with no record alone: the keyboard writes the record first', async () => {
    const h = harness({ 'job-9.m4a': 'audio' });
    await drainKeyboardDirectOutbox(h.deps);
    expect(h.disk).toEqual({ 'job-9.m4a': 'audio' });
  });

  it('rescues a take the keyboard was killed before encoding as a retryable WAV', async () => {
    const h = harness({
      'job-1.json': JSON.stringify(record({ status: 'pending', startedAtMs: NOW - 11 * MINUTE })),
      'job-1.pcm': 'raw',
    });
    expect(await drainKeyboardDirectOutbox(h.deps)).toEqual({
      completed: 0,
      failed: 1,
      dropped: 0,
    });
    expect(h.failed).toEqual([
      expect.objectContaining({
        id: 'job-1',
        audioUrl: 'file:///group/direct-dictations/job-1.wav',
        audioFileName: 'job-1.wav',
        audioMimeType: 'audio/wav',
      }),
    ]);
    expect(h.disk).toEqual({ 'job-1.wav': 'wav(raw)' });
  });

  it('drops a failed dictation with no audio left, since there is nothing to retry', async () => {
    const h = harness({ 'job-1.json': JSON.stringify(record({ status: 'failed' })) });
    expect(await drainKeyboardDirectOutbox(h.deps)).toEqual({
      completed: 0,
      failed: 0,
      dropped: 1,
    });
    expect(h.failed).toEqual([]);
    expect(h.disk).toEqual({});
  });

  it('drops it when the raw take cannot be made into a WAV', async () => {
    const h = harness(
      { 'job-1.json': JSON.stringify(record({ status: 'failed' })), 'job-1.pcm': 'raw' },
      { wrapFails: true },
    );
    expect(await drainKeyboardDirectOutbox(h.deps)).toEqual({
      completed: 0,
      failed: 0,
      dropped: 1,
    });
    expect(h.disk).toEqual({});
  });

  it('does nothing without the App Group folder', async () => {
    const h = harness({});
    expect(await drainKeyboardDirectOutbox({ ...h.deps, files: null })).toEqual({
      completed: 0,
      failed: 0,
      dropped: 0,
    });
  });
});
