import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { ToneStep } from '../ToneStep';

jest.mock('@/lib/sentry', () => ({ Sentry: { captureException: jest.fn() } }));
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: require('react-native').View }));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('@/components/ui/Button', () => {
  const { Pressable, Text } = require('react-native');
  return {
    Button: ({
      children,
      onPress,
      disabled,
      loading,
    }: {
      children: React.ReactNode;
      onPress: () => void;
      disabled?: boolean;
      loading?: boolean;
    }) => (
      <Pressable onPress={onPress} disabled={disabled || loading}>
        <Text>{children}</Text>
      </Pressable>
    ),
  };
});
const mockGoNext = jest.fn();
const mockGoBack = jest.fn();
jest.mock('@/store/useOnboardingStore', () => ({
  useOnboardingStore: (selector: (s: unknown) => unknown) =>
    selector({ goNext: mockGoNext, goBack: mockGoBack, selectedMode: null }),
  getStepProgress: () => ({ current: 6, total: 9 }),
}));
const mockUpdateConfig = jest.fn();
const mockConfigState = {
  config: { keyboardTone: 'default' },
  error: null as string | null,
  updateConfig: mockUpdateConfig,
};
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: Object.assign((selector: (s: unknown) => unknown) => selector(mockConfigState), {
    getState: () => mockConfigState,
  }),
}));
jest.mock('@/store/useAuthStore', () => ({ useAuthStore: { getState: jest.fn() } }));
jest.mock('@/store/useProcessingModeStore', () => ({
  useProcessingModeStore: { getState: jest.fn() },
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockConfigState.config.keyboardTone = 'default';
  mockConfigState.error = null;
  mockUpdateConfig.mockResolvedValue(undefined);
  mockGoNext.mockResolvedValue(undefined);
});

it('shows illustrative examples and saves a selected tone only on Continue', async () => {
  const screen = render(<ToneStep />);
  expect(screen.getAllByRole('radio')).toHaveLength(5);
  expect(screen.getByRole('radio', { name: /^Default\./ })).toBeSelected();
  fireEvent.press(screen.getByRole('radio', { name: /^Formal\./ }));
  expect(screen.getByRole('radio', { name: /^Formal\./ })).toBeSelected();
  expect(mockUpdateConfig).not.toHaveBeenCalled();
  fireEvent.press(screen.getByText('Continue'));
  await waitFor(() => expect(mockGoNext).toHaveBeenCalledWith('tone'));
  expect(mockUpdateConfig).toHaveBeenCalledWith({ keyboardTone: 'formal' });
});

it('preserves the saved tone when skipping', async () => {
  mockConfigState.config.keyboardTone = 'casual';
  const screen = render(<ToneStep />);
  expect(screen.getByRole('radio', { name: /^Casual\./ })).toBeSelected();
  fireEvent.press(screen.getByRole('radio', { name: /^Excited\./ }));
  fireEvent.press(screen.getByText('Skip'));
  await waitFor(() => expect(mockGoNext).toHaveBeenCalledWith('tone'));
  expect(mockUpdateConfig).not.toHaveBeenCalled();
});

it('stays on the preview and allows retry when saving fails', async () => {
  mockUpdateConfig.mockImplementationOnce(async () => {
    mockConfigState.error = 'Disk unavailable';
  });
  const screen = render(<ToneStep />);
  fireEvent.press(screen.getByText('Continue'));
  expect(await screen.findByText('Could not save your progress. Try again.')).toBeTruthy();
  expect(mockGoNext).not.toHaveBeenCalled();
  mockConfigState.error = null;
  fireEvent.press(screen.getByRole('radio', { name: /^Excited\./ }));
  fireEvent.press(screen.getByText('Retry'));
  await waitFor(() => expect(mockGoNext).toHaveBeenCalledTimes(1));
  expect(mockUpdateConfig).toHaveBeenLastCalledWith({ keyboardTone: 'excited' });
});

// Tones only change keyboard dictation; in-app recordings are never toned.
it('says the tone applies to keyboard dictation', () => {
  const screen = render(<ToneStep />);
  expect(screen.getByText(/keyboard dictation/)).toBeTruthy();
});

it('reads each tone with its description and example to screen readers', () => {
  const screen = render(<ToneStep />);
  expect(
    screen.getByRole('radio', {
      name: 'Formal. Professional and polished. Example: Hi Sam, would you be available for lunch tomorrow at noon? Please let me know if that time is convenient.',
    }),
  ).toBeTruthy();
});
