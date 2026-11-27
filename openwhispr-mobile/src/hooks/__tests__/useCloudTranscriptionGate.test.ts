import { renderHook } from '@testing-library/react-native';
import { SUPERWALL_PLACEMENTS } from '@/lib/superwall';

type MockUser = { id: string; isAnonymous: boolean } | null;

let mockUser: MockUser = null;
let mockProvider = 'cloud';
const mockUsage = { wordsUsed: 10 };

jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: (selector: (state: { user: MockUser }) => unknown) => selector({ user: mockUser }),
}));
jest.mock('@/store/useUsageStore', () => ({
  useUsageStore: (selector: (state: { usage: typeof mockUsage }) => unknown) =>
    selector({ usage: mockUsage }),
}));
jest.mock('@/lib/inferenceRouting', () => ({
  getTranscriptionProvider: (scope: string) => (scope === 'dictation' ? mockProvider : 'local'),
}));
jest.mock('@/lib/superwall', () => ({
  ...jest.requireActual('@/lib/superwall'),
  buildUsageGateParams: (usage: unknown) => ({ fromUsage: usage }),
}));

const mockRegister = jest.fn();
jest.mock('@/hooks/useSuperwallGate', () => ({
  useSuperwallGate: () => ({ register: mockRegister }),
}));

const mockShowAccountRequiredAlert = jest.fn();
jest.mock('@/lib/accountAccess', () => ({
  accountRequiredForCloud: (user: MockUser) => !user,
  showAccountRequiredAlert: (...args: unknown[]) => mockShowAccountRequiredAlert(...args),
}));

import { useCloudTranscriptionGate } from '../useCloudTranscriptionGate';

beforeEach(() => {
  jest.clearAllMocks();
  mockUser = { id: 'u', isAnonymous: true };
  mockProvider = 'cloud';
  mockRegister.mockImplementation(async ({ feature }: { feature?: () => void }) => {
    feature?.();
    return true;
  });
});

describe('useCloudTranscriptionGate', () => {
  it('asks for an account before cloud transcription, as the Record tab does', () => {
    mockUser = null;
    const run = jest.fn();
    const { result } = renderHook(() => useCloudTranscriptionGate());

    result.current(run);

    expect(mockShowAccountRequiredAlert).toHaveBeenCalledWith('recording');
    expect(mockRegister).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it('runs cloud transcription through its paywall, an anonymous session included', () => {
    const run = jest.fn();
    const { result } = renderHook(() => useCloudTranscriptionGate());

    result.current(run);

    expect(mockRegister).toHaveBeenCalledWith(
      expect.objectContaining({
        placement: SUPERWALL_PLACEMENTS.cloudTranscriptionStart,
        params: { fromUsage: mockUsage },
        requiresAccount: false,
      }),
    );
    expect(run).toHaveBeenCalledTimes(1);
  });

  it.each(['local', 'byok'])('runs straight away when transcription is %s', (provider) => {
    mockProvider = provider;
    mockUser = null;
    const run = jest.fn();
    const { result } = renderHook(() => useCloudTranscriptionGate());

    result.current(run);

    expect(run).toHaveBeenCalledTimes(1);
    expect(mockRegister).not.toHaveBeenCalled();
    expect(mockShowAccountRequiredAlert).not.toHaveBeenCalled();
  });
});
