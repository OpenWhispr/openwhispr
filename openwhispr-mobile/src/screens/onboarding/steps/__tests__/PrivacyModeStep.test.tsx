import { Platform } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
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
let mockSavedCleanup: { mode: string } | undefined;
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: (selector: (state: unknown) => unknown) =>
    selector({ config: { inference: { cleanup: mockSavedCleanup } } }),
}));
let mockReadiness: { status: string } = { status: 'ready' };
jest.mock('@/lib/localReasoning', () => ({
  ...jest.requireActual('@/lib/localReasoning'),
  getLocalReasoningReadiness: async () => mockReadiness,
}));
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
jest.mock('@/components/ui/SystemIcon', () => ({
  SystemIcon: ({ mdName }: { mdName: string }) => {
    const { View } = require('react-native');
    return <View testID={`icon-${mdName}`} />;
  },
}));
jest.mock('@/components/ui/OpenWhisprMark', () => ({ OpenWhisprMark: () => null }));

const originalPlatform = Platform.OS;
afterEach(() => {
  Platform.OS = originalPlatform;
});
beforeEach(() => {
  Platform.OS = 'ios';
  jest.clearAllMocks();
  mockSelectedMode = null;
  mockReadiness = { status: 'ready' };
  mockSavedCleanup = undefined;
  jest.mocked(chooseOnboardingMode).mockResolvedValue(undefined);
  mockCancelActiveDownloads.mockResolvedValue(undefined);
});
// The Private Mode card's cleanup line waits on Apple Intelligence readiness.
async function renderStep(): Promise<ReturnType<typeof render>> {
  const screen = render(<PrivacyModeStep />);
  await act(async () => {});
  return screen;
}
const CLOUD = 'OpenWhispr Cloud';
const LOCAL = 'Private Mode';

it('describes each mode in a few short lines', async () => {
  const screen = await renderStep();
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

// The Private Mode card's cleanup line matches what choosing it saves on this phone.
describe('cleanup line', () => {
  it.each(['ready', 'modelNotReady'])(
    'includes cleanup when Apple Intelligence is %s',
    async (status) => {
      mockReadiness = { status };
      const screen = await renderStep();
      expect(screen.getByText('Cleanup with Apple Intelligence')).toBeTruthy();
      expect(screen.queryByText(/Settings/)).toBeNull();
      expect(screen.queryByTestId('icon-Minus')).toBeNull();
    },
  );

  it('says cleanup starts once Apple Intelligence is turned on', async () => {
    mockReadiness = { status: 'appleIntelligenceOff' };
    const screen = await renderStep();
    expect(screen.getByText('Cleanup with Apple Intelligence')).toBeTruthy();
    expect(
      screen.getByText('Starts once it’s on in Settings → Apple Intelligence & Siri.'),
    ).toBeTruthy();
  });

  it.each([
    [
      'unsupportedDevice',
      'No cleanup on this iPhone',
      'Needs Apple Intelligence (iPhone 15 Pro or later). You’ll get the raw transcription.',
    ],
    [
      'unsupportedOS',
      'No cleanup on this iPhone yet',
      'Needs iOS 26 on an iPhone with Apple Intelligence. Until then, you’ll get the raw transcription.',
    ],
  ])('marks cleanup as not included when %s', async (status, text, hint) => {
    mockReadiness = { status };
    const screen = await renderStep();
    expect(screen.getByText(text)).toBeTruthy();
    expect(screen.getByText(hint)).toBeTruthy();
    expect(screen.getAllByTestId('icon-Minus')).toHaveLength(1);
    expect(screen.queryByText(/Cleanup with Apple Intelligence/)).toBeNull();
  });

  it('names no Apple Intelligence on Android', async () => {
    Platform.OS = 'android';
    mockReadiness = { status: 'unsupportedOS' };
    const screen = await renderStep();
    expect(screen.getByText('No automatic cleanup')).toBeTruthy();
    expect(screen.getByText('You’ll get the raw transcription.')).toBeTruthy();
    expect(screen.queryByText(/Apple Intelligence|iPhone/)).toBeNull();
  });

  // A provider saved for cleanup keeps cleaning in Private mode, on any phone.
  it.each(['ios', 'android'] as const)('names a saved cleanup provider (%s)', async (os) => {
    Platform.OS = os;
    mockReadiness = { status: 'unsupportedDevice' };
    mockSavedCleanup = { mode: 'providers' };
    const screen = await renderStep();
    expect(screen.getByText('Cleanup with your saved provider')).toBeTruthy();
    expect(
      screen.getByText('Your transcription is sent to the provider you chose in AI Models.'),
    ).toBeTruthy();
    expect(screen.queryByText(/Apple Intelligence|raw transcription/)).toBeNull();
  });

  // Private mode never runs it, so the line is the one for this phone.
  it('ignores a saved Cloud cleanup', async () => {
    mockSavedCleanup = { mode: 'openwhispr' };
    const screen = await renderStep();
    expect(screen.getByText('Cleanup with Apple Intelligence')).toBeTruthy();
  });

  // Neither says whether this iPhone can run it, so the card makes no claim.
  it.each(['disabled', 'unavailable'])(
    'shows no cleanup line when readiness is %s',
    async (status) => {
      mockReadiness = { status };
      const screen = await renderStep();
      expect(screen.queryByText(/cleanup on this|Cleanup with|raw transcription/)).toBeNull();
    },
  );
});
it('lists Cloud first and selects it by default', async () => {
  const screen = await renderStep();
  const [first, second] = screen.getAllByRole('radio');
  expect(first.props.accessibilityLabel).toBe(CLOUD);
  expect(second.props.accessibilityLabel).toBe(LOCAL);
  expect(screen.getByLabelText(CLOUD).props.accessibilityState).toEqual({ selected: true });
  expect(screen.getByLabelText(LOCAL).props.accessibilityState).toEqual({ selected: false });
  expect(screen.queryByText('Use Cloud')).toBeNull();
  expect(screen.queryByText('Use Local')).toBeNull();
});
it('keeps the earlier Local choice when revisiting the step', async () => {
  mockSelectedMode = 'private';
  const screen = await renderStep();
  expect(screen.getByLabelText(LOCAL).props.accessibilityState).toEqual({ selected: true });
});
it.each([
  [CLOUD, 'cloud'],
  [LOCAL, 'private'],
] as const)('commits %s on Continue', async (label, mode) => {
  const screen = await renderStep();
  fireEvent.press(screen.getByLabelText(label));
  expect(chooseOnboardingMode).not.toHaveBeenCalled();
  fireEvent.press(screen.getByText('Continue'));
  await waitFor(() => expect(chooseOnboardingMode).toHaveBeenCalledWith(mode, 'privacy-mode'));
});
it('keeps the choices available after a failed Cloud attempt', async () => {
  jest
    .mocked(chooseOnboardingMode)
    .mockRejectedValueOnce(new OnboardingError('Cloud is unavailable'));
  const screen = await renderStep();
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
  const screen = await renderStep();
  fireEvent.press(screen.getByLabelText(CLOUD));
  fireEvent.press(screen.getByText('Continue'));
  await waitFor(() => expect(mockCancelActiveDownloads).toHaveBeenCalledTimes(1));
});
// Reset onboarding shows setup straight away, so a model downloading from Settings is not ours.
it('leaves other downloads alone when Local was not chosen in this setup', async () => {
  const screen = await renderStep();
  fireEvent.press(screen.getByText('Continue'));
  await waitFor(() => expect(chooseOnboardingMode).toHaveBeenCalledWith('cloud', 'privacy-mode'));
  expect(mockCancelActiveDownloads).not.toHaveBeenCalled();
});
