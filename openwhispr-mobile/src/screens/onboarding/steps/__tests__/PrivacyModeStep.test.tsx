import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { PrivacyModeStep } from '../PrivacyModeStep';
import { chooseOnboardingMode } from '@/lib/onboardingMode';
import { OnboardingError } from '@/lib/onboardingErrors';
let mockSelectedMode: string | null = null;
jest.mock('@/lib/sentry', () => ({ Sentry: { captureException: jest.fn() } }));
jest.mock('@/store/useOnboardingStore', () => ({
  useOnboardingStore: (selector: (state: unknown) => unknown) =>
    selector({ selectedMode: mockSelectedMode }),
}));
jest.mock('@/lib/onboardingMode', () => ({ chooseOnboardingMode: jest.fn() }));
jest.mock('@/hooks/useOnboardingStep', () => ({
  useOnboardingStep: () => ({ goBack: jest.fn(), progress: { current: 6, total: 8 } }),
}));
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: require('react-native').View }));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('@/components/ui/OpenWhisprMark', () => ({ OpenWhisprMark: () => null }));

beforeEach(() => {
  jest.clearAllMocks();
  mockSelectedMode = null;
  jest.mocked(chooseOnboardingMode).mockResolvedValue(undefined);
});
it('shows the confirmed mode when revisiting the choice', () => {
  mockSelectedMode = 'private';
  const screen = render(<PrivacyModeStep />);
  expect(screen.getByText('Local is selected')).toBeTruthy();
});
it.each([
  ['Use Cloud', 'cloud'],
  ['Use Local', 'private'],
] as const)('commits %s without an extra Continue tap', async (label, mode) => {
  const screen = render(<PrivacyModeStep />);
  fireEvent.press(screen.getByText(label));
  await waitFor(() => expect(chooseOnboardingMode).toHaveBeenCalledWith(mode, 'privacy-mode'));
  expect(screen.queryByText('Continue')).toBeNull();
});
it('keeps the choices available after a failed Cloud attempt', async () => {
  jest
    .mocked(chooseOnboardingMode)
    .mockRejectedValueOnce(new OnboardingError('Cloud is unavailable'));
  const screen = render(<PrivacyModeStep />);
  fireEvent.press(screen.getByText('Use Cloud'));
  expect(await screen.findByText('Cloud is unavailable')).toBeTruthy();
  fireEvent.press(screen.getByText('Use Local'));
  await waitFor(() => expect(chooseOnboardingMode).toHaveBeenCalledWith('private', 'privacy-mode'));
});
