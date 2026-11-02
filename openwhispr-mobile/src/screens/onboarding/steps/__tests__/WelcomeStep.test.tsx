import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { WelcomeStep } from '../WelcomeStep';

const mockGoNext = jest.fn();
jest.mock('@/lib/sentry', () => ({ Sentry: { captureException: jest.fn() } }));
jest.mock('@/hooks/useOnboardingStep', () => ({
  useOnboardingStep: () => ({ goNext: mockGoNext }),
}));
jest.mock('@/components/onboarding/AnimatedKeyboardPreview', () => ({
  AnimatedKeyboardPreview: () => null,
}));
jest.mock('expo-video', () => ({
  VideoView: () => null,
  useVideoPlayer: () => ({ play: jest.fn(), pause: jest.fn() }),
}));
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: require('react-native').View }));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));

beforeEach(() => {
  jest.clearAllMocks();
  mockGoNext.mockResolvedValue(undefined);
});

it('leads with the security promise beside the set-up video', () => {
  const screen = render(<WelcomeStep />);
  expect(screen.getByRole('header')).toHaveTextContent('Security-first speech to text');
  for (const text of [
    'Dictate naturally anywhere on iPhone. Emails, messages, notes and AI chats.',
    'No selling your data',
    'No advertising profile',
    'You control where processing happens',
  ]) {
    expect(screen.getByText(text)).toBeTruthy();
  }
});

it('moves on when Set up is tapped', async () => {
  const screen = render(<WelcomeStep />);
  fireEvent.press(screen.getByText('Set up'));
  await waitFor(() => expect(mockGoNext).toHaveBeenCalledTimes(1));
});
