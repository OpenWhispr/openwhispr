import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: require('react-native').View,
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));

const mockGoNext = jest.fn();
jest.mock('@/store/useOnboardingStore', () => ({
  useOnboardingStore: (selector: (s: { goNext: () => Promise<void> }) => unknown) =>
    selector({ goNext: mockGoNext }),
  getStepProgress: () => ({ current: 1, total: 1 }),
}));

const mockRegister = jest.fn();
type MockGate = { isConfigured: boolean; state: { status: string } };
let mockGate: MockGate = { isConfigured: true, state: { status: 'idle' } };
jest.mock('@/hooks/useSuperwallGate', () => ({
  useSuperwallGate: () => ({ register: mockRegister, ...mockGate }),
}));

type MockAuthState = { user: { id: string; isAnonymous: boolean } | null };
let mockAuthState: MockAuthState = { user: { id: 'anon-user', isAnonymous: true } };
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: (selector: (s: MockAuthState) => unknown) => selector(mockAuthState),
}));

type MockUsageState = { usage: { isSubscribed: boolean } | null };
let mockUsageState: MockUsageState = { usage: null };
jest.mock('@/store/useUsageStore', () => ({
  useUsageStore: (selector: (s: MockUsageState) => unknown) => selector(mockUsageState),
}));

import { PAYWALL_ESCAPE_MS, PAYWALL_READY_GRACE_MS, PaywallStep } from '../PaywallStep';
import { SUPERWALL_PLACEMENTS } from '@/lib/superwall';

beforeEach(() => {
  jest.clearAllMocks();
  mockGoNext.mockResolvedValue(undefined);
  mockRegister.mockResolvedValue(true);
  mockAuthState = { user: { id: 'anon-user', isAnonymous: true } };
  mockUsageState = { usage: null };
  mockGate = { isConfigured: true, state: { status: 'idle' } };
});

afterEach(() => {
  jest.useRealTimers();
});

describe('PaywallStep', () => {
  it('presents the onboarding placement on mount', async () => {
    render(<PaywallStep />);

    await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(1));
    expect(mockRegister.mock.calls[0][0].placement).toBe(SUPERWALL_PLACEMENTS.onboardingPaywall);
  });

  it('advances to the account step once the paywall closes', async () => {
    render(<PaywallStep />);

    await waitFor(() => expect(mockGoNext).toHaveBeenCalledTimes(1));
  });

  // The property that matters most here: nothing about Superwall may strand a
  // first run. A rejected register still has to hand off to the account step.
  it('advances even when the paywall fails to present', async () => {
    mockRegister.mockRejectedValue(new Error('Superwall unavailable'));

    render(<PaywallStep />);

    await waitFor(() => expect(mockGoNext).toHaveBeenCalledTimes(1));
  });

  it('offers a working escape once a paywall that never resolves has had its chance', async () => {
    jest.useFakeTimers();
    mockRegister.mockReturnValue(new Promise<boolean>(() => {}));

    const { getByText } = render(<PaywallStep />);
    act(() => {
      jest.advanceTimersByTime(PAYWALL_ESCAPE_MS);
    });
    fireEvent.press(getByText('Continue'));

    expect(mockGoNext).toHaveBeenCalledTimes(1);
  });

  // Between register and the SDK actually presenting, the backdrop is a
  // normal-looking screen with a primary button. Tapping it would mount the
  // account step underneath a paywall that then presents on top of it.
  it('keeps Continue inert while the paywall is still being presented', () => {
    mockRegister.mockReturnValue(new Promise<boolean>(() => {}));

    const { getByText } = render(<PaywallStep />);
    fireEvent.press(getByText('Continue'));

    expect(mockGoNext).not.toHaveBeenCalled();
  });

  it('re-enables Continue once the SDK reports the paywall failed to present', () => {
    mockRegister.mockReturnValue(new Promise<boolean>(() => {}));
    const { getByText, rerender } = render(<PaywallStep />);

    mockGate = { isConfigured: true, state: { status: 'error' } };
    rerender(<PaywallStep />);
    fireEvent.press(getByText('Continue'));

    expect(mockGoNext).toHaveBeenCalledTimes(1);
  });

  // A cold launch that resumes on this step arrives before the SDK has
  // configured; registering then is answered immediately for a
  // non-transactional placement and would skip the paywall for good.
  it('waits for the SDK to configure before presenting', async () => {
    mockGate = { isConfigured: false, state: { status: 'idle' } };

    const { rerender } = render(<PaywallStep />);
    expect(mockRegister).not.toHaveBeenCalled();

    mockGate = { isConfigured: true, state: { status: 'idle' } };
    rerender(<PaywallStep />);

    await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(1));
  });

  it('presents anyway once the readiness grace period elapses', () => {
    jest.useFakeTimers();
    mockGate = { isConfigured: false, state: { status: 'idle' } };

    render(<PaywallStep />);
    act(() => {
      jest.advanceTimersByTime(PAYWALL_READY_GRACE_MS);
    });

    expect(mockRegister).toHaveBeenCalledTimes(1);
  });

  it('advances exactly once when the user also taps continue', async () => {
    let releaseRegister: (value: boolean) => void = () => {};
    mockRegister.mockReturnValue(
      new Promise<boolean>((resolve) => {
        releaseRegister = resolve;
      }),
    );

    const { getByText } = render(<PaywallStep />);
    fireEvent.press(getByText('Continue'));
    releaseRegister(true);

    await waitFor(() => expect(mockGoNext).toHaveBeenCalled());
    expect(mockGoNext).toHaveBeenCalledTimes(1);
  });

  // Without a session there is no billing identity: a purchase made now could
  // not be attributed to anyone and would simply be lost.
  it('skips the paywall when there is no session to attribute a purchase to', async () => {
    mockAuthState = { user: null };

    render(<PaywallStep />);

    await waitFor(() => expect(mockGoNext).toHaveBeenCalledTimes(1));
    expect(mockRegister).not.toHaveBeenCalled();
  });

  it('skips the paywall for a user who is already subscribed', async () => {
    mockUsageState = { usage: { isSubscribed: true } };

    render(<PaywallStep />);

    await waitFor(() => expect(mockGoNext).toHaveBeenCalledTimes(1));
    expect(mockRegister).not.toHaveBeenCalled();
  });

  it('does not advance after unmounting mid-presentation', async () => {
    let releaseRegister: (value: boolean) => void = () => {};
    mockRegister.mockReturnValue(
      new Promise<boolean>((resolve) => {
        releaseRegister = resolve;
      }),
    );

    const { unmount } = render(<PaywallStep />);
    unmount();
    releaseRegister(true);
    await Promise.resolve();

    expect(mockGoNext).not.toHaveBeenCalled();
  });
});
