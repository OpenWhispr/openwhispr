import { fireEvent, render, waitFor } from '@testing-library/react-native';

jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: require('react-native').View }));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));

const mockGoNext = jest.fn();
const mockCaptureException = jest.fn();
jest.mock('@/lib/sentry', () => ({
  Sentry: { captureException: (...args: unknown[]) => mockCaptureException(...args) },
}));
jest.mock('@/store/useOnboardingStore', () => ({
  getStepProgress: () => undefined,
  useOnboardingStore: (selector: (s: { goNext: () => Promise<void> }) => unknown) =>
    selector({ goNext: mockGoNext }),
}));

type MockAuthState = {
  user: { id: string; isAnonymous: boolean } | null;
  isGuest: boolean;
};
let mockAuthState: MockAuthState = { user: null, isGuest: false };
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: (selector: (s: MockAuthState) => unknown) => selector(mockAuthState),
}));

// Stand in for the real sign-in UI, exposing only the skip affordance so the
// step's own contract is what gets tested.
jest.mock('@/screens/AuthScreen', () => {
  const { Pressable, Text } = require('react-native');
  return {
    __esModule: true,
    default: ({ onGuestContinue }: { onGuestContinue?: () => void }) => (
      <Pressable onPress={onGuestContinue}>
        <Text>{onGuestContinue ? 'skip' : 'default skip'}</Text>
      </Pressable>
    ),
  };
});

import { CreateAccountStep } from '../CreateAccountStep';

beforeEach(() => {
  jest.clearAllMocks();
  mockGoNext.mockResolvedValue(undefined);
  mockAuthState = { user: null, isGuest: false };
});

describe('CreateAccountStep', () => {
  // The whole of onboarding runs on an anonymous session, so "signed in" here
  // has to mean a real account or this step would end the moment it mounts.
  it('stays put while the user is only an anonymous onboarding session', () => {
    mockAuthState = { user: { id: 'anon-user', isAnonymous: true }, isGuest: false };

    render(<CreateAccountStep />);

    expect(mockGoNext).not.toHaveBeenCalled();
  });

  it('advances once a real account exists', () => {
    mockAuthState = { user: { id: 'real-user', isAnonymous: false }, isGuest: false };

    render(<CreateAccountStep />);

    expect(mockGoNext).toHaveBeenCalledTimes(1);
  });

  it('advances for a legacy guest with no anonymous session', () => {
    mockAuthState = { user: null, isGuest: true };

    render(<CreateAccountStep />);

    expect(mockGoNext).toHaveBeenCalledTimes(1);
  });

  it('advances when the user skips, keeping the anonymous session', () => {
    mockAuthState = { user: { id: 'anon-user', isAnonymous: true }, isGuest: false };

    const { getByText } = render(<CreateAccountStep />);
    fireEvent.press(getByText('skip'));

    expect(mockGoNext).toHaveBeenCalledTimes(1);
  });

  // With no session there is nothing to keep, and advancing here would only
  // re-render the same sign-in screen underneath: the default guest action
  // (which sets guest mode) is the one that actually lets the user through.
  it('leaves skip to the default guest action when no session exists', () => {
    mockAuthState = { user: null, isGuest: false };

    const { getByText } = render(<CreateAccountStep />);

    expect(getByText('default skip')).toBeTruthy();
    expect(mockGoNext).not.toHaveBeenCalled();
  });

  // A rejected advance (a keychain write) must not latch the once-guard shut:
  // the user would sit on a sign-in screen with no way forward.
  it('reports a failed advance and lets the user try again', async () => {
    mockAuthState = { user: { id: 'anon-user', isAnonymous: true }, isGuest: false };
    mockGoNext.mockRejectedValueOnce(new Error('keychain unavailable'));

    const { findByText, getByText } = render(<CreateAccountStep />);
    fireEvent.press(getByText('skip'));
    await waitFor(() => expect(mockCaptureException).toHaveBeenCalledTimes(1));
    fireEvent.press(await findByText('Retry'));

    await waitFor(() => expect(mockGoNext).toHaveBeenCalledTimes(2));
  });

  // The sign-in that ends this step doesn't happen again, so a failed save needs its own retry.
  it('offers a retry when saving progress fails after signing in', async () => {
    mockAuthState = { user: { id: 'real-user', isAnonymous: false }, isGuest: false };
    mockGoNext.mockRejectedValueOnce(new Error('keychain unavailable'));

    const { findByText } = render(<CreateAccountStep />);
    expect(await findByText('Could not save your progress. Try again.')).toBeTruthy();
    fireEvent.press(await findByText('Retry'));

    await waitFor(() => expect(mockGoNext).toHaveBeenCalledTimes(2));
  });

  it('keeps the retry screen up while the retry is saving', async () => {
    mockAuthState = { user: { id: 'real-user', isAnonymous: false }, isGuest: false };
    mockGoNext
      .mockRejectedValueOnce(new Error('keychain unavailable'))
      .mockReturnValueOnce(new Promise<void>(() => undefined));

    const { findByText, queryByText } = render(<CreateAccountStep />);
    fireEvent.press(await findByText('Retry'));

    await waitFor(() => expect(mockGoNext).toHaveBeenCalledTimes(2));
    expect(queryByText('skip')).toBeNull();
    expect(queryByText('Could not save your progress. Try again.')).toBeTruthy();
  });

  it('advances only once when signup lands after a skip', () => {
    mockAuthState = { user: { id: 'anon-user', isAnonymous: true }, isGuest: false };

    const { getByText, rerender } = render(<CreateAccountStep />);
    fireEvent.press(getByText('skip'));

    mockAuthState = { user: { id: 'real-user', isAnonymous: false }, isGuest: false };
    rerender(<CreateAccountStep />);

    expect(mockGoNext).toHaveBeenCalledTimes(1);
  });
});
