jest.mock('whisper.rn', () => ({
  initWhisper: jest.fn(),
}));

jest.mock('expo-file-system/legacy', () => ({
  getInfoAsync: async () => ({ exists: true }),
  makeDirectoryAsync: async () => undefined,
  documentDirectory: '/doc/',
}));

import { LocalWhisperService } from '../LocalWhisperService';

describe('LocalWhisperService word-timestamp plumbing', () => {
  const fakeSegments = [
    { text: 'hello', t0: 0, t1: 50 },
    { text: 'world', t0: 60, t1: 110 },
  ];

  const installFakeContext = (capture: { opts?: Record<string, unknown> }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = LocalWhisperService as any;
    svc.whisperContext = {
      transcribe: (_uri: string, opts: Record<string, unknown>) => {
        capture.opts = opts;
        return {
          promise: Promise.resolve({
            result: 'hello world',
            segments: fakeSegments,
            isAborted: false,
          }),
        };
      },
    };
    svc.isAvailable = () => true;
    svc.getAvailableModels = async () => [{ name: 'base', downloaded: true, path: '/m/base.bin' }];
    svc.getModelsDir = () => '/m/';
    svc.ensureModelInitialized = async () => undefined;
    svc.runExclusive = (fn: () => Promise<unknown>) => fn();
  };

  it('enables tokenTimestamps + maxLen:1 and returns segments when wordTimestamps:true', async () => {
    const capture: { opts?: Record<string, unknown> } = {};
    installFakeContext(capture);
    const res = await LocalWhisperService.transcribe('file://x.wav', { wordTimestamps: true });
    expect(capture.opts).toMatchObject({ tokenTimestamps: true, maxLen: 1 });
    expect(res.segments).toEqual(fakeSegments);
    expect(res.text).toBe('hello world');
  });

  it('keeps the dictation defaults (no segments) when wordTimestamps is omitted', async () => {
    const capture: { opts?: Record<string, unknown> } = {};
    installFakeContext(capture);
    const res = await LocalWhisperService.transcribe('file://x.wav');
    expect(capture.opts).toMatchObject({ tokenTimestamps: false, maxLen: 0 });
    expect(res.segments).toBeUndefined();
  });
});
