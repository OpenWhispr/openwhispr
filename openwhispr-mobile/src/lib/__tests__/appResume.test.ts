jest.mock('@/store/useHandoffStore', () => ({
  useHandoffStore: { getState: jest.fn() },
}));
jest.mock('@/store/useGoogleCalendarStore', () => ({
  useGoogleCalendarStore: { getState: jest.fn() },
}));
jest.mock('@/store/useUsageStore', () => ({
  useUsageStore: { getState: jest.fn() },
}));
jest.mock('@/store/useKeyboardRecoveryStore', () => ({
  isRecoveryHolding: jest.fn(),
  isRecoveryDeepLinkFresh: jest.fn(),
}));

import { useHandoffStore } from '@/store/useHandoffStore';
import { useGoogleCalendarStore } from '@/store/useGoogleCalendarStore';
import { useUsageStore } from '@/store/useUsageStore';
import { isRecoveryDeepLinkFresh, isRecoveryHolding } from '@/store/useKeyboardRecoveryStore';
import { resolveResumeAction } from '../appResume';

const handoffState = useHandoffStore.getState as jest.Mock;
const calendarState = useGoogleCalendarStore.getState as jest.Mock;
const usageState = useUsageStore.getState as jest.Mock;
const recoveryHolding = isRecoveryHolding as jest.Mock;
const recoveryDeepLinkFresh = isRecoveryDeepLinkFresh as jest.Mock;

function setStores(overrides?: {
  handoffActive?: boolean;
  checkingInitialUrl?: boolean;
  calendarAuthActive?: boolean;
  billingActive?: boolean;
  keyboardRecoveryActive?: boolean;
  keyboardRecoveryDeepLinkFresh?: boolean;
}): void {
  handoffState.mockReturnValue({
    isActive: overrides?.handoffActive ?? false,
    isCheckingInitialUrl: overrides?.checkingInitialUrl ?? false,
  });
  calendarState.mockReturnValue({
    isAuthSessionActive: overrides?.calendarAuthActive ?? false,
  });
  usageState.mockReturnValue({
    isBillingSessionActive: overrides?.billingActive ?? false,
  });
  recoveryHolding.mockReturnValue(overrides?.keyboardRecoveryActive ?? false);
  recoveryDeepLinkFresh.mockReturnValue(overrides?.keyboardRecoveryDeepLinkFresh ?? false);
}

describe('resolveResumeAction', () => {
  beforeEach(() => {
    setStores();
  });

  it('resets to home on an ordinary warm resume', () => {
    expect(resolveResumeAction(false)).toEqual({ resetToHome: true, refreshUsage: false });
  });

  it('skips the redundant replace when home is already on top', () => {
    expect(resolveResumeAction(true)).toEqual({ resetToHome: false, refreshUsage: false });
  });

  it('stays put during a keyboard handoff', () => {
    setStores({ handoffActive: true });
    expect(resolveResumeAction(false)).toEqual({ resetToHome: false, refreshUsage: false });

    setStores({ checkingInitialUrl: true });
    expect(resolveResumeAction(false)).toEqual({ resetToHome: false, refreshUsage: false });
  });

  it('stays put during a google calendar auth session', () => {
    setStores({ calendarAuthActive: true });
    expect(resolveResumeAction(false)).toEqual({ resetToHome: false, refreshUsage: false });
  });

  // The user is sent to Settings to restore Full Access; bouncing them Home on
  // the way back would drop them one tap short of finishing.
  it('stays put while the keyboard Full Access recovery screen is open', () => {
    setStores({ keyboardRecoveryActive: true });
    expect(resolveResumeAction(false)).toEqual({ resetToHome: false, refreshUsage: false });
  });

  // The screen raises its own flag from a mount effect, which can flush after this
  // resume handler has already run — so the deep-link stamp has to hold the line on
  // its own, before anything is mounted.
  it('stays put while a recovery deep link is still in flight', () => {
    setStores({ keyboardRecoveryActive: false, keyboardRecoveryDeepLinkFresh: true });
    expect(resolveResumeAction(false)).toEqual({ resetToHome: false, refreshUsage: false });
  });

  it('resets to home once the stamp has expired and the screen is gone', () => {
    setStores({ keyboardRecoveryActive: false, keyboardRecoveryDeepLinkFresh: false });
    expect(resolveResumeAction(false)).toEqual({ resetToHome: true, refreshUsage: false });
  });

  // Returning from the external billing portal must keep Account in place and
  // refresh any subscription-management change without a manual reload.
  it('stays put and refreshes usage when returning from a billing session', () => {
    setStores({ billingActive: true });
    expect(resolveResumeAction(false)).toEqual({ resetToHome: false, refreshUsage: true });
  });

  it('does not refresh usage for a billing session that never started', () => {
    expect(resolveResumeAction(false).refreshUsage).toBe(false);
  });
});
