const mockReturnToPreviousApp = jest.fn();
jest.mock('../../../modules/app-group-storage/src', () => ({
  AppGroupStorage: { returnToPreviousApp: () => mockReturnToPreviousApp() },
}));

import { useHandoffStore } from '@/store/useHandoffStore';
import { applyReturnOutcome, returnToHost, RETURN_OUTCOME_TIMEOUT_MS } from '../handoffReturn';

function returnSnapshot(): { returnState: string; returnHostName: string | null } {
  const { returnState, returnHostName } = useHandoffStore.getState();
  return { returnState, returnHostName };
}

beforeEach(() => {
  jest.useRealTimers();
  mockReturnToPreviousApp.mockReset();
  useHandoffStore.getState().setActive(true);
});

describe('useHandoffStore return state', () => {
  it('starts every handoff in the returning state', () => {
    useHandoffStore.getState().setReturnState('manual', 'Slack');
    useHandoffStore.getState().setActive(true);
    expect(returnSnapshot()).toEqual({ returnState: 'returning', returnHostName: null });
  });
});

describe('applyReturnOutcome', () => {
  // The app is backgrounded after a successful open; if the user comes back
  // mid-recording, "Returning…" would be a lie. Offer the button instead.
  it('offers the button after a successful return', () => {
    applyReturnOutcome({ status: 'opened', hostName: 'Slack' });
    expect(returnSnapshot()).toEqual({ returnState: 'manual', returnHostName: 'Slack' });
  });

  it('offers the button when the return failed (prompt cancelled)', () => {
    applyReturnOutcome({ status: 'failed', hostName: 'Slack' });
    expect(returnSnapshot()).toEqual({ returnState: 'manual', returnHostName: 'Slack' });
  });

  it('falls back to the swipe screen when there is no target', () => {
    applyReturnOutcome({ status: 'no_target' });
    expect(returnSnapshot()).toEqual({ returnState: 'manual', returnHostName: null });
  });

  it('ignores a skipped duplicate and an absent outcome', () => {
    applyReturnOutcome({ status: 'skipped' });
    applyReturnOutcome(undefined);
    expect(returnSnapshot()).toEqual({ returnState: 'returning', returnHostName: null });
  });
});

describe('returnToHost', () => {
  it('uses the native return by default and applies its outcome', async () => {
    mockReturnToPreviousApp.mockResolvedValue({ status: 'failed', hostName: 'Messages' });
    await returnToHost();
    expect(mockReturnToPreviousApp).toHaveBeenCalledTimes(1);
    expect(returnSnapshot()).toEqual({ returnState: 'manual', returnHostName: 'Messages' });
  });

  it('uses the opener it is given', async () => {
    const openHost = jest.fn().mockResolvedValue({ status: 'opened', hostName: 'Slack' });
    await returnToHost(openHost);
    expect(openHost).toHaveBeenCalledTimes(1);
    expect(mockReturnToPreviousApp).not.toHaveBeenCalled();
  });

  it('gives up on a return that never resolves', async () => {
    jest.useFakeTimers();
    const pending = returnToHost(() => new Promise(() => {}));
    jest.advanceTimersByTime(RETURN_OUTCOME_TIMEOUT_MS);
    await pending;
    expect(returnSnapshot()).toEqual({ returnState: 'manual', returnHostName: null });
  });
});
