import { Alert } from 'react-native';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { UsageInfo } from '@/data/remote/usageApi';
import { SUPERWALL_PLACEMENTS } from '@/lib/superwall';
import { UsageLimitError } from '@/lib/usageLimitError';
import { useUsageLimitRecovery } from '../useUsageLimitRecovery';

const mockRegisterSuperwallGate = jest.fn();
const mockLoadUsage = jest.fn();
const mockReconcileStoreBilling = jest.fn();
const mockRouterPush = jest.fn();
const mockUsage: UsageInfo = {
  billingUserId: '00000000-0000-4000-8000-000000000001',
  wordsUsed: 2_000,
  wordsRemaining: 0,
  limit: 2_000,
  plan: 'free',
  status: 'active',
  isSubscribed: false,
  isTrial: false,
  trialDaysLeft: null,
  currentPeriodEnd: null,
  billingInterval: null,
  resetAt: '2026-08-14T00:00:00.000Z',
};
const mockUsageStoreState = {
  usage: mockUsage,
  load: mockLoadUsage,
};

jest.mock('expo-router', () => ({
  router: { push: (...args: unknown[]) => mockRouterPush(...args) },
}));
jest.mock('@/hooks/useSuperwallGate', () => ({
  useSuperwallGate: () => ({ register: mockRegisterSuperwallGate }),
}));
jest.mock('@/store/useUsageStore', () => ({
  useUsageStore: Object.assign(
    (selector: (state: typeof mockUsageStoreState) => unknown) => selector(mockUsageStoreState),
    { getState: () => mockUsageStoreState },
  ),
}));
jest.mock('@/lib/billingReconciliation', () => ({
  reconcileStoreBilling: (...args: unknown[]) => mockReconcileStoreBilling(...args),
}));
jest.mock('@/components/ui/UsageMeter', () => ({
  formatResetLabel: jest.fn(() => 'Resets in 3d'),
}));

function expectQuotaGuidance(): void {
  expect(Alert.alert).toHaveBeenCalledWith(
    'Weekly Limit Reached',
    expect.stringContaining('Switch to Private Mode'),
    expect.arrayContaining([
      expect.objectContaining({ text: 'View Usage', onPress: expect.any(Function) }),
      expect.objectContaining({ text: 'Upgrade', onPress: expect.any(Function) }),
    ]),
  );
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('useUsageLimitRecovery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRegisterSuperwallGate.mockReset();
    mockLoadUsage.mockReset();
    mockReconcileStoreBilling.mockReset();
    mockRouterPush.mockReset();
    jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => jest.useRealTimers());

  it('shows actionable quota guidance when the Superwall gate does not complete', async () => {
    mockRegisterSuperwallGate.mockResolvedValue(false);
    const retryWithCloud = jest.fn();
    const { result } = renderHook(() => useUsageLimitRecovery());

    await act(async () => {
      await result.current.handleUsageLimitReached(
        new UsageLimitError('Weekly word limit reached', { source: 'transcription' }),
        retryWithCloud,
      );
    });

    expectQuotaGuidance();
    expect(retryWithCloud).not.toHaveBeenCalled();
  });

  it('routes fallback upgrades back through the Account Superwall placement', async () => {
    mockRegisterSuperwallGate.mockResolvedValue(false);
    const { result } = renderHook(() => useUsageLimitRecovery());

    await act(async () => {
      await result.current.handleUsageLimitReached(
        new UsageLimitError('Weekly word limit reached', { source: 'transcription' }),
        jest.fn(),
      );
    });

    const buttons = (Alert.alert as jest.Mock).mock.calls[0][2] as Array<{
      text: string;
      onPress?: () => void;
    }>;
    buttons.find((button) => button.text === 'Upgrade')?.onPress?.();

    expect(mockRouterPush).toHaveBeenCalledWith({
      pathname: '/(account)',
      params: { superwallPlacement: SUPERWALL_PLACEMENTS.accountBillingOpen },
    });
  });

  it('does not register another gate while recovery is already active', async () => {
    const firstGate = deferred<boolean>();
    mockRegisterSuperwallGate.mockReturnValue(firstGate.promise);
    const { result } = renderHook(() => useUsageLimitRecovery());

    let firstRecovery: Promise<void> | undefined;
    act(() => {
      firstRecovery = result.current.handleUsageLimitReached(
        new UsageLimitError('Weekly word limit reached', { source: 'transcription' }),
        jest.fn(),
      );
    });
    await waitFor(() => expect(mockRegisterSuperwallGate).toHaveBeenCalledTimes(1));

    await act(async () => {
      await result.current.handleUsageLimitReached(
        new UsageLimitError('Weekly word limit reached', { source: 'transcription' }),
        jest.fn(),
      );
    });

    expect(mockRegisterSuperwallGate).toHaveBeenCalledTimes(1);
    expectQuotaGuidance();

    await act(async () => {
      firstGate.resolve(false);
      await firstRecovery;
    });
  });

  it('shows actionable quota guidance when billing completes without cloud access', async () => {
    jest.useFakeTimers();
    mockRegisterSuperwallGate.mockResolvedValue(true);
    mockReconcileStoreBilling.mockResolvedValue(mockUsage);
    mockLoadUsage.mockResolvedValue({
      status: 'loaded',
      usage: mockUsage,
      loadedAt: Date.now(),
    });
    const retryWithCloud = jest.fn();
    const { result } = renderHook(() => useUsageLimitRecovery());

    let recoveryPromise: Promise<void> | undefined;
    act(() => {
      recoveryPromise = result.current.handleUsageLimitReached(
        new UsageLimitError('Weekly word limit reached', { source: 'transcription' }),
        retryWithCloud,
      );
    });
    await act(async () => {
      await jest.runAllTimersAsync();
      await recoveryPromise;
    });

    expectQuotaGuidance();
    expect(retryWithCloud).not.toHaveBeenCalled();
  });

  it('shows actionable quota guidance when billing recovery errors', async () => {
    mockRegisterSuperwallGate.mockRejectedValue(new Error('Superwall unavailable'));
    const retryWithCloud = jest.fn();
    const { result } = renderHook(() => useUsageLimitRecovery());

    await act(async () => {
      await result.current.handleUsageLimitReached(
        new UsageLimitError('Weekly word limit reached', { source: 'transcription' }),
        retryWithCloud,
      );
    });

    expectQuotaGuidance();
    expect(retryWithCloud).not.toHaveBeenCalled();
  });
});
