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
const mockCancelActiveDownloads = jest.fn();
jest.mock('@/store/useModelDownloadStore', () => ({
  useModelDownloadStore: (selector: (state: unknown) => unknown) =>
    selector({ cancelActiveDownloads: mockCancelActiveDownloads }),
}));
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
  mockCancelActiveDownloads.mockResolvedValue(undefined);
});
const CLOUD = 'OpenWhispr Cloud';
const LOCAL = 'Local · Private mode';

it('describes each mode in a few short lines', () => {
  const screen = render(<PrivacyModeStep />);
  for (const text of [
    'Zero setup',
    'Everything runs on your device. Nothing is ever uploaded.',
    'Works fully offline',
    'Faster transcription',
    'Higher quality',
    'Automatic cleanup & formatting',
  ]) {
    expect(screen.getByText(text)).toBeTruthy();
  }
  expect(screen.queryByText(/tone/i)).toBeNull();
  expect(screen.queryByText(/voice agent/i)).toBeNull();
  expect(screen.queryByText(/Pro offer/i)).toBeNull();
});
it('lists Cloud first and selects it by default', () => {
  const screen = render(<PrivacyModeStep />);
  const [first, second] = screen.getAllByRole('radio');
  expect(first.props.accessibilityLabel).toBe(CLOUD);
  expect(second.props.accessibilityLabel).toBe(LOCAL);
  expect(screen.getByLabelText(CLOUD).props.accessibilityState).toEqual({ selected: true });
  expect(screen.getByLabelText(LOCAL).props.accessibilityState).toEqual({ selected: false });
  expect(screen.queryByText('Use Cloud')).toBeNull();
  expect(screen.queryByText('Use Local')).toBeNull();
});
it('keeps the earlier Local choice when revisiting the step', () => {
  mockSelectedMode = 'private';
  const screen = render(<PrivacyModeStep />);
  expect(screen.getByLabelText(LOCAL).props.accessibilityState).toEqual({ selected: true });
});
it.each([
  [CLOUD, 'cloud'],
  [LOCAL, 'private'],
] as const)('commits %s on Continue', async (label, mode) => {
  const screen = render(<PrivacyModeStep />);
  fireEvent.press(screen.getByLabelText(label));
  expect(chooseOnboardingMode).not.toHaveBeenCalled();
  fireEvent.press(screen.getByText('Continue'));
  await waitFor(() => expect(chooseOnboardingMode).toHaveBeenCalledWith(mode, 'privacy-mode'));
});
it('keeps the choices available after a failed Cloud attempt', async () => {
  jest
    .mocked(chooseOnboardingMode)
    .mockRejectedValueOnce(new OnboardingError('Cloud is unavailable'));
  const screen = render(<PrivacyModeStep />);
  fireEvent.press(screen.getByText('Continue'));
  expect(await screen.findByText('Cloud is unavailable')).toBeTruthy();
  fireEvent.press(screen.getByLabelText(LOCAL));
  fireEvent.press(screen.getByText('Continue'));
  await waitFor(() => expect(chooseOnboardingMode).toHaveBeenCalledWith('private', 'privacy-mode'));
  expect(mockCancelActiveDownloads).not.toHaveBeenCalled();
});
// Back from the download step leaves its model transferring; Cloud has no use for it.
it('stops a Local download left running once Cloud is chosen', async () => {
  mockSelectedMode = 'private';
  const screen = render(<PrivacyModeStep />);
  fireEvent.press(screen.getByLabelText(CLOUD));
  fireEvent.press(screen.getByText('Continue'));
  await waitFor(() => expect(mockCancelActiveDownloads).toHaveBeenCalledTimes(1));
});
// Reset onboarding shows setup straight away, so a model downloading from Settings is not ours.
it('leaves other downloads alone when Local was not chosen in this setup', async () => {
  const screen = render(<PrivacyModeStep />);
  fireEvent.press(screen.getByText('Continue'));
  await waitFor(() => expect(chooseOnboardingMode).toHaveBeenCalledWith('cloud', 'privacy-mode'));
  expect(mockCancelActiveDownloads).not.toHaveBeenCalled();
});
