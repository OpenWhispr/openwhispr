import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

jest.mock('@/lib/sentry', () => ({ Sentry: { captureException: jest.fn() } }));
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

type MockUsage = { isSubscribed: boolean };
type MockUsageState = { usage: MockUsage | null; ownerKey: string | null };
const OWNER = 'user-1:cookie';
let mockUsageState: MockUsageState = { usage: null, ownerKey: null };
let mockCurrentOwnerKey: string | null = OWNER;
const mockLoad = jest.fn();
jest.mock('@/store/useUsageStore', () => ({
  useUsageStore: Object.assign(
    (selector: (s: MockUsageState) => unknown) => selector(mockUsageState),
    { getState: () => ({ ...mockUsageState, load: mockLoad }) },
  ),
  getUsageOwnerKey: () => mockCurrentOwnerKey,
}));

const FREE: MockUsage = { isSubscribed: false };
const SUBSCRIBED: MockUsage = { isSubscribed: true };
const PRO_TITLE = 'Go further with OpenWhispr Pro.';
const PRO_HIGHLIGHT = 'Sync notes across devices';

import { PAYWALL_ESCAPE_MS, PAYWALL_READY_GRACE_MS, PaywallStep } from '../PaywallStep';
import { SUPERWALL_PLACEMENTS } from '@/lib/superwall';

beforeEach(() => {
  jest.clearAllMocks();
  mockGoNext.mockResolvedValue(undefined);
  mockRegister.mockResolvedValue(true);
  mockAuthState = { user: { id: 'anon-user', isAnonymous: true } };
  mockUsageState = { usage: FREE, ownerKey: OWNER };
  mockCurrentOwnerKey = OWNER;
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

  it('advances to the saved setup destination once the paywall closes', async () => {
    render(<PaywallStep />);

    await waitFor(() => expect(mockGoNext).toHaveBeenCalledTimes(1));
  });

  // The property that matters most here: nothing about Superwall may strand a
  // first run. A rejected register still has to hand off to the saved setup destination.
  it('advances even when the paywall fails to present', async () => {
    mockRegister.mockRejectedValue(new Error('Superwall unavailable'));

    render(<PaywallStep />);

    await waitFor(() => expect(mockGoNext).toHaveBeenCalledTimes(1));
  });

  it('offers a working escape once a paywall that never resolves has had its chance', async () => {
    jest.useFakeTimers();
    mockRegister.mockReturnValue(new Promise<boolean>(() => {}));

    const { getByText } = render(<PaywallStep />);
    await act(async () => {});
    expect(mockRegister).toHaveBeenCalledTimes(1);
    await act(async () => {
      jest.advanceTimersByTime(PAYWALL_ESCAPE_MS);
    });
    await act(async () => {
      fireEvent.press(getByText('Continue'));
    });

    expect(mockGoNext).toHaveBeenCalledTimes(1);
    expect(mockRegister.mock.calls[0][0].signal.aborted).toBe(true);
  });

  // Between register and the SDK actually presenting, the backdrop is a
  // normal-looking screen with a primary button. Tapping it would mount the
  // account step underneath a paywall that then presents on top of it.
  it('keeps Continue inert while the paywall is still being presented', async () => {
    mockRegister.mockReturnValue(new Promise<boolean>(() => {}));

    const { getByText } = render(<PaywallStep />);
    await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(1));
    await act(async () => {
      fireEvent.press(getByText('Continue'));
    });

    expect(mockGoNext).not.toHaveBeenCalled();
  });

  it('re-enables Continue once the SDK reports the paywall failed to present', async () => {
    mockRegister.mockReturnValue(new Promise<boolean>(() => {}));
    const { getByText, rerender } = render(<PaywallStep />);
    await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(1));

    mockGate = { isConfigured: true, state: { status: 'error' } };
    rerender(<PaywallStep />);
    await act(async () => {
      fireEvent.press(getByText('Continue'));
    });

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

  it('presents anyway once the readiness grace period elapses', async () => {
    jest.useFakeTimers();
    mockGate = { isConfigured: false, state: { status: 'idle' } };

    render(<PaywallStep />);
    await act(async () => {
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

    mockGate = { isConfigured: true, state: { status: 'error' } };

    const { getByText } = render(<PaywallStep />);
    await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(1));
    await act(async () => {
      fireEvent.press(getByText('Continue'));
    });
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
    mockUsageState = { usage: SUBSCRIBED, ownerKey: OWNER };

    render(<PaywallStep />);

    await waitFor(() => expect(mockGoNext).toHaveBeenCalledTimes(1));
    expect(mockRegister).not.toHaveBeenCalled();
  });

  // Until /api/usage answers, `usage` is null, which used to read as "not
  // subscribed" and showed a paid user the offer. An unconfirmed plan skips at
  // once: holding everyone for a usage round trip costs more than a free user
  // missing this one offer, and later limit and feature paywalls still reach them.
  describe('when the plan is not confirmed', () => {
    it('advances at once, without loading usage, when usage has not loaded', async () => {
      jest.useFakeTimers();
      mockUsageState = { usage: null, ownerKey: null };

      render(<PaywallStep />);
      await act(async () => {});

      expect(mockGoNext).toHaveBeenCalledTimes(1);
      expect(mockRegister).not.toHaveBeenCalled();
      expect(mockLoad).not.toHaveBeenCalled();
    });

    it('advances when the loaded usage belongs to another account', async () => {
      mockUsageState = { usage: FREE, ownerKey: 'previous-user:cookie' };

      render(<PaywallStep />);

      await waitFor(() => expect(mockGoNext).toHaveBeenCalledTimes(1));
      expect(mockRegister).not.toHaveBeenCalled();
    });

    it('advances when the session has no usage owner', async () => {
      mockCurrentOwnerKey = null;

      render(<PaywallStep />);

      await waitFor(() => expect(mockGoNext).toHaveBeenCalledTimes(1));
      expect(mockRegister).not.toHaveBeenCalled();
    });

    it('does not present when usage arrives after the step has skipped', async () => {
      let releaseGoNext: () => void = () => {};
      mockGoNext.mockReturnValue(
        new Promise<void>((resolve) => {
          releaseGoNext = resolve;
        }),
      );
      mockUsageState = { usage: null, ownerKey: null };

      const { rerender, queryByText } = render(<PaywallStep />);
      mockUsageState = { usage: FREE, ownerKey: OWNER };
      rerender(<PaywallStep />);
      await act(async () => {});

      expect(mockRegister).not.toHaveBeenCalled();
      expect(queryByText(PRO_TITLE)).toBeNull();
      releaseGoNext();
    });

    it('lets the user retry when saving progress fails on the skip path', async () => {
      mockGoNext.mockRejectedValueOnce(new Error('disk full'));
      mockUsageState = { usage: null, ownerKey: null };

      const screen = render(<PaywallStep />);
      expect(await screen.findByText('Could not save progress. Try again.')).toBeTruthy();
      fireEvent.press(screen.getByText('Continue'));

      await waitFor(() => expect(mockGoNext).toHaveBeenCalledTimes(2));
      expect(mockRegister).not.toHaveBeenCalled();
    });
  });

  // A paid or unconfirmed account must not see the Pro pitch even for the
  // frame before the step advances.
  describe('Pro copy', () => {
    it.each([
      ['usage has not loaded', { usage: null, ownerKey: null }],
      ['the account is subscribed', { usage: SUBSCRIBED, ownerKey: OWNER }],
      ['usage belongs to another account', { usage: FREE, ownerKey: 'previous-user:cookie' }],
    ])('is not rendered when %s', (_label, usageState: MockUsageState) => {
      mockGoNext.mockReturnValue(new Promise<void>(() => {}));
      mockUsageState = usageState;

      const { queryByText } = render(<PaywallStep />);

      expect(queryByText(PRO_TITLE)).toBeNull();
      expect(queryByText(PRO_HIGHLIGHT)).toBeNull();
    });

    it('is not rendered when there is no session', () => {
      mockGoNext.mockReturnValue(new Promise<void>(() => {}));
      mockAuthState = { user: null };

      const { queryByText } = render(<PaywallStep />);

      expect(queryByText(PRO_TITLE)).toBeNull();
    });

    it('is rendered for a free account while the paywall is on its way', () => {
      mockGate = { isConfigured: false, state: { status: 'idle' } };

      const { getByText } = render(<PaywallStep />);

      expect(getByText(PRO_TITLE)).toBeTruthy();
      expect(getByText(PRO_HIGHLIGHT)).toBeTruthy();
    });

    it('is withdrawn when a free account turns out to be subscribed before presenting', async () => {
      mockGate = { isConfigured: false, state: { status: 'idle' } };
      const { rerender, queryByText } = render(<PaywallStep />);

      mockUsageState = { usage: SUBSCRIBED, ownerKey: OWNER };
      rerender(<PaywallStep />);

      await waitFor(() => expect(mockGoNext).toHaveBeenCalledTimes(1));
      expect(queryByText(PRO_TITLE)).toBeNull();
      expect(mockRegister).not.toHaveBeenCalled();
    });
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

it('allows retrying continuation after a progress save fails', async () => {
  mockGoNext.mockRejectedValueOnce(
    new Error("Calling the 'setValueWithKeyAsync' function has failed"),
  );
  const screen = render(<PaywallStep />);
  expect(await screen.findByText('Could not save progress. Try again.')).toBeTruthy();
  expect(screen.queryByText(/setValueWithKeyAsync/)).toBeNull();
  fireEvent.press(screen.getByText('Continue'));
  await waitFor(() => expect(mockGoNext).toHaveBeenCalledTimes(2));
  expect(mockRegister).toHaveBeenCalledTimes(1);
});
