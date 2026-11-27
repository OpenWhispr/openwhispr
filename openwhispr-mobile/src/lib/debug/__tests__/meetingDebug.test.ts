import { ROTATION_MS } from '@/services/transcription/realtimeReconnect';
import {
  getDebugRotationMs,
  meetingRotationMs,
  setDebugRotationMs,
  timeSpeakerPass,
  type SpeakerPassTimingDeps,
} from '../meetingDebug';

const globals = globalThis as unknown as { __DEV__: boolean };

describe('meetingRotationMs', () => {
  const originalDev = globals.__DEV__;

  afterEach(() => {
    globals.__DEV__ = true;
    setDebugRotationMs(null);
    globals.__DEV__ = originalDev;
  });

  it('is the real interval by default', () => {
    globals.__DEV__ = true;
    expect(meetingRotationMs()).toBe(ROTATION_MS);
  });

  it('uses the override in a development build', () => {
    globals.__DEV__ = true;
    setDebugRotationMs(120_000);
    expect(getDebugRotationMs()).toBe(120_000);
    expect(meetingRotationMs()).toBe(120_000);
  });

  it('goes back to the real interval when the override is cleared', () => {
    globals.__DEV__ = true;
    setDebugRotationMs(120_000);
    setDebugRotationMs(null);
    expect(meetingRotationMs()).toBe(ROTATION_MS);
  });

  it('rejects an interval that is not positive', () => {
    globals.__DEV__ = true;
    setDebugRotationMs(0);
    expect(meetingRotationMs()).toBe(ROTATION_MS);
  });

  it('cannot be set in a release build', () => {
    globals.__DEV__ = false;
    setDebugRotationMs(120_000);
    expect(meetingRotationMs()).toBe(ROTATION_MS);
  });

  it('ignores an override set earlier once the build is not a development one', () => {
    globals.__DEV__ = true;
    setDebugRotationMs(120_000);
    globals.__DEV__ = false;
    expect(getDebugRotationMs()).toBeNull();
    expect(meetingRotationMs()).toBe(ROTATION_MS);
  });
});

describe('timeSpeakerPass', () => {
  const makeDeps = (overrides: Partial<SpeakerPassTimingDeps> = {}): SpeakerPassTimingDeps => {
    const ticks = [1000, 1400, 9400];
    return {
      transcodeToWav: jest.fn(async () => ({ uri: 'file:///tmp/copy.wav', durationMs: 7_200_000 })),
      diarize: jest.fn(async () => ({
        speakerCount: 2,
        segments: [
          { start: 0, end: 4, speakerId: 0 },
          { start: 4, end: 9, speakerId: 1 },
          { start: 9, end: 12, speakerId: 0 },
        ],
        embeddings: {},
      })),
      cleanup: jest.fn(async () => undefined),
      now: () => ticks.shift() ?? 0,
      ...overrides,
    };
  };

  it('reports each stage and removes the converted copy', async () => {
    const deps = makeDeps();
    await expect(timeSpeakerPass('file:///in.m4a', deps)).resolves.toEqual({
      audioMs: 7_200_000,
      transcodeMs: 400,
      diarizeMs: 8000,
      speakerCount: 2,
      turnCount: 3,
    });
    expect(deps.transcodeToWav).toHaveBeenCalledWith('file:///in.m4a');
    expect(deps.diarize).toHaveBeenCalledWith('file:///tmp/copy.wav');
    expect(deps.cleanup).toHaveBeenCalledWith(['file:///tmp/copy.wav']);
  });

  it('removes the converted copy when the speaker pass fails', async () => {
    const deps = makeDeps({
      diarize: jest.fn(async () => {
        throw new Error('model missing');
      }),
    });
    await expect(timeSpeakerPass('file:///in.m4a', deps)).rejects.toThrow('model missing');
    expect(deps.cleanup).toHaveBeenCalledWith(['file:///tmp/copy.wav']);
  });

  it('still reports the timing when clean-up fails', async () => {
    const deps = makeDeps({
      cleanup: jest.fn(async () => {
        throw new Error('gone');
      }),
    });
    await expect(timeSpeakerPass('file:///in.m4a', deps)).resolves.toMatchObject({
      diarizeMs: 8000,
    });
  });
});
