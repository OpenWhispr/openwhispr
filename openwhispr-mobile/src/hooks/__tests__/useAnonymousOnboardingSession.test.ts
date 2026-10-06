import { AppState, type AppStateStatus } from 'react-native';
import { renderHook } from '@testing-library/react-native';

const mockEnsureAnonymousSession = jest.fn();
type MockAuthState = {
  isInitialized: boolean;
  user: { id: string } | null;
  ensureAnonymousSession: jest.Mock;
};
let mockAuthState: MockAuthState = {
  isInitialized: true,
  user: null,
  ensureAnonymousSession: mockEnsureAnonymousSession,
};
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: (selector: (state: MockAuthState) => unknown) => selector(mockAuthState),
}));

type MockOnboardingState = { hydrated: boolean; finished: boolean; currentStep: string };
let mockOnboardingState: MockOnboardingState = {
  hydrated: true,
  finished: false,
  currentStep: 'security-first',
};
jest.mock('@/store/useOnboardingStore', () => ({
  useOnboardingStore: (selector: (state: MockOnboardingState) => unknown) =>
    selector(mockOnboardingState),
}));

let mockHasRealAccountHistory = false;
jest.mock('@/sync/syncIdentity', () => ({
  hasRealAccountHistory: () => mockHasRealAccountHistory,
}));
jest.mock('@/utils/onboarding', () => ({ FIRST_ONBOARDING_STEP: 'get-started' }));

import { useAnonymousOnboardingSession } from '../useAnonymousOnboardingSession';

type AppStateHandler = (state: AppStateStatus) => void;
let appStateHandlers: AppStateHandler[] = [];
const mockRemove = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  appStateHandlers = [];
  mockAuthState = {
    isInitialized: true,
    user: null,
    ensureAnonymousSession: mockEnsureAnonymousSession,
  };
  mockOnboardingState = { hydrated: true, finished: false, currentStep: 'security-first' };
  mockHasRealAccountHistory = false;
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, handler) => {
    appStateHandlers.push(handler as AppStateHandler);
    return { remove: mockRemove };
  });
});

function foreground(): void {
  for (const handler of appStateHandlers) handler('active');
}

describe('useAnonymousOnboardingSession', () => {
  it('opens a session once onboarding is hydrated and unfinished with no user', () => {
    renderHook(() => useAnonymousOnboardingSession());

    expect(mockEnsureAnonymousSession).toHaveBeenCalledTimes(1);
  });

  // A first launch offline gets no session and nothing in the store changes on
  // that failure, so the only reliable retry signal is the app coming back.
  it('retries each time the app returns to the foreground without a session', () => {
    renderHook(() => useAnonymousOnboardingSession());
    foreground();
    foreground();

    expect(mockEnsureAnonymousSession).toHaveBeenCalledTimes(3);
  });

  it('stops listening once a session exists', () => {
    const { rerender } = renderHook(() => useAnonymousOnboardingSession());
    mockAuthState = { ...mockAuthState, user: { id: 'anon' } };
    rerender(undefined);

    expect(mockRemove).toHaveBeenCalledTimes(1);
  });

  it('does nothing for a device that already finished onboarding', () => {
    mockOnboardingState = { hydrated: true, finished: true, currentStep: 'security-first' };

    renderHook(() => useAnonymousOnboardingSession());
    foreground();

    expect(mockEnsureAnonymousSession).not.toHaveBeenCalled();
  });

  // Nothing before the dictation demo needs a server session, and a row minted
  // behind the splash would outlive someone who opens the app once and deletes
  // it. Wait until the user has actually started.
  it('holds off while the user is still on the Get Started screen', () => {
    mockOnboardingState = { hydrated: true, finished: false, currentStep: 'get-started' };

    renderHook(() => useAnonymousOnboardingSession());
    foreground();

    expect(mockEnsureAnonymousSession).not.toHaveBeenCalled();
  });

  // "Reset onboarding" on a device that synced a real account replays the
  // flow as a demo; minting a new identity there would read as an account
  // switch and wipe that account's local notes.
  it('does not mint a session on a device with a real account history', () => {
    mockHasRealAccountHistory = true;

    renderHook(() => useAnonymousOnboardingSession());

    expect(mockEnsureAnonymousSession).not.toHaveBeenCalled();
  });

  it('waits for onboarding state to hydrate', () => {
    mockOnboardingState = { hydrated: false, finished: false, currentStep: 'security-first' };

    renderHook(() => useAnonymousOnboardingSession());

    expect(mockEnsureAnonymousSession).not.toHaveBeenCalled();
  });
});
