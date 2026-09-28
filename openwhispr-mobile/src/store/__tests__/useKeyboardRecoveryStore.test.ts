import {
  consumeRecoveryDeepLink,
  isRecoveryDeepLinkFresh,
  isRecoveryHolding,
  useKeyboardRecoveryStore,
} from '@/store/useKeyboardRecoveryStore';

const NOW = 1_800_000_000_000;
const MINUTE_MS = 60 * 1000;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
  useKeyboardRecoveryStore.setState({
    isRecoveryActive: false,
    deepLinkAtMs: null,
    backgroundedAtMs: null,
  });
});

afterEach(() => {
  jest.useRealTimers();
});

describe('isRecoveryHolding', () => {
  it('does not hold when the screen is not mounted', () => {
    expect(isRecoveryHolding()).toBe(false);
  });

  it('holds while the screen is mounted and in the foreground', () => {
    useKeyboardRecoveryStore.getState().setRecoveryActive(true);
    expect(isRecoveryHolding()).toBe(true);
  });

  it('keeps holding across a normal Settings trip', () => {
    useKeyboardRecoveryStore.getState().setRecoveryActive(true);
    useKeyboardRecoveryStore.getState().markBackgrounded();
    jest.setSystemTime(NOW + 2 * MINUTE_MS);

    expect(isRecoveryHolding()).toBe(true);
  });

  // The bound that matters: a screen opened and abandoned must not switch off the
  // app's "warm resume lands on Home" behaviour for the rest of the session.
  it('stops holding once the screen has been backgrounded too long', () => {
    useKeyboardRecoveryStore.getState().setRecoveryActive(true);
    useKeyboardRecoveryStore.getState().markBackgrounded();
    jest.setSystemTime(NOW + 11 * MINUTE_MS);

    expect(isRecoveryHolding()).toBe(false);
  });

  it('starts a fresh window when the screen is re-mounted', () => {
    useKeyboardRecoveryStore.getState().setRecoveryActive(true);
    useKeyboardRecoveryStore.getState().markBackgrounded();
    jest.setSystemTime(NOW + 11 * MINUTE_MS);
    useKeyboardRecoveryStore.getState().setRecoveryActive(true);

    expect(isRecoveryHolding()).toBe(true);
  });
});

describe('isRecoveryDeepLinkFresh', () => {
  it('is false with no deep link', () => {
    expect(isRecoveryDeepLinkFresh()).toBe(false);
  });

  it('covers the window before the screen mounts, then expires', () => {
    useKeyboardRecoveryStore.getState().markRecoveryDeepLink();
    expect(isRecoveryDeepLinkFresh()).toBe(true);

    jest.setSystemTime(NOW + 11_000);
    expect(isRecoveryDeepLinkFresh()).toBe(false);
  });

  it('is cleared by the screen actually mounting', () => {
    useKeyboardRecoveryStore.getState().markRecoveryDeepLink();
    useKeyboardRecoveryStore.getState().setRecoveryActive(true);

    expect(isRecoveryDeepLinkFresh()).toBe(false);
  });
});

describe('consumeRecoveryDeepLink', () => {
  // The AuthScreen case: the link arrived while the navigator was not rendered, so
  // it has to survive the sign-in and be claimed exactly once afterwards.
  it('claims an outstanding link once and only once', () => {
    useKeyboardRecoveryStore.getState().markRecoveryDeepLink();

    expect(consumeRecoveryDeepLink()).toBe(true);
    expect(consumeRecoveryDeepLink()).toBe(false);
  });

  it('reports nothing to claim when no link arrived', () => {
    expect(consumeRecoveryDeepLink()).toBe(false);
  });

  it('survives an arbitrarily long sign-in', () => {
    useKeyboardRecoveryStore.getState().markRecoveryDeepLink();
    jest.setSystemTime(NOW + 30 * MINUTE_MS);

    expect(consumeRecoveryDeepLink()).toBe(true);
  });
});
