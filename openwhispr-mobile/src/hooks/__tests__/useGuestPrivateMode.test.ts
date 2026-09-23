import { renderHook } from '@testing-library/react-native';
import { useProcessingModeStore } from '@/store/useProcessingModeStore';

type MockAuthState = {
  isInitialized: boolean;
  isGuest: boolean;
  user: { id: string; isAnonymous: boolean } | null;
};
let mockAuthState: MockAuthState = { isInitialized: true, isGuest: false, user: null };
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: (selector: (state: MockAuthState) => unknown) => selector(mockAuthState),
}));

import { useGuestPrivateMode } from '../useGuestPrivateMode';

beforeEach(() => {
  useProcessingModeStore.setState({ activeMode: 'cloud', isUserOverride: false });
});

describe('useGuestPrivateMode', () => {
  it('forces Private for a guest, who has no session for cloud transcription', () => {
    mockAuthState = { isInitialized: true, isGuest: true, user: null };

    renderHook(() => useGuestPrivateMode());

    expect(useProcessingModeStore.getState().activeMode).toBe('private');
  });

  // A fresh install has no user until the anonymous session lands. Forcing
  // Private in that window would send the onboarding dictation demo to a local
  // model that is not downloaded yet, and nothing restores Cloud afterwards.
  it('leaves Cloud alone while the anonymous session is still pending', () => {
    mockAuthState = { isInitialized: true, isGuest: false, user: null };

    renderHook(() => useGuestPrivateMode());

    expect(useProcessingModeStore.getState().activeMode).toBe('cloud');
  });

  it('leaves a signed-in user alone', () => {
    mockAuthState = { isInitialized: true, isGuest: false, user: { id: 'u', isAnonymous: true } };

    renderHook(() => useGuestPrivateMode());

    expect(useProcessingModeStore.getState().activeMode).toBe('cloud');
  });

  it('waits for auth to initialize before deciding', () => {
    mockAuthState = { isInitialized: false, isGuest: true, user: null };

    renderHook(() => useGuestPrivateMode());

    expect(useProcessingModeStore.getState().activeMode).toBe('cloud');
  });
});
