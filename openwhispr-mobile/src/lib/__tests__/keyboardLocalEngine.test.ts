import {
  readKeyboardLocalEngine,
  refreshKeyboardLocalEngine,
  subscribeKeyboardLocalEngine,
} from '@/lib/keyboardLocalEngine';
import { LocalTranscriptionService } from '@/services/transcription/LocalTranscriptionService';

jest.mock('@/services/transcription/LocalTranscriptionService', () => ({
  LocalTranscriptionService: { getAvailability: jest.fn() },
}));
jest.mock('@/lib/inferenceRouting', () => ({ getPickedLocalModel: jest.fn(() => 'parakeet-v2') }));
jest.mock('@/lib/transcriptionLanguage', () => ({
  getPreferredTranscriptionLanguages: jest.fn(() => ['en']),
}));

const mockGetAvailability = LocalTranscriptionService.getAvailability as jest.MockedFunction<
  typeof LocalTranscriptionService.getAvailability
>;

describe('keyboardLocalEngine', () => {
  it('refresh resolves the picked model and notifies', async () => {
    mockGetAvailability.mockResolvedValueOnce({
      parakeetSupported: true,
      parakeetV2Downloaded: true,
      parakeetV3Downloaded: false,
      whisperDownloaded: false,
    });
    const listener = jest.fn();
    const unsubscribe = subscribeKeyboardLocalEngine(listener);
    await refreshKeyboardLocalEngine();
    expect(readKeyboardLocalEngine()).toEqual({ engine: 'parakeet', version: 'v2' });
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('a failed availability read resolves to null', async () => {
    mockGetAvailability.mockRejectedValueOnce(new Error('native module gone'));
    const listener = jest.fn();
    const unsubscribe = subscribeKeyboardLocalEngine(listener);
    await refreshKeyboardLocalEngine();
    expect(readKeyboardLocalEngine()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });
});
