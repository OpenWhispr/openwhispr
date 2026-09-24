import type React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

// nativewind's cssInterop breaks jest's transform; same stub the other screen suites use.
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('../SlowDownloadSheet', () => {
  const { Pressable, Text } = require('react-native');
  return {
    SlowDownloadSheet: ({
      visible,
      onContinueCloud,
    }: {
      visible: boolean;
      onContinueCloud: () => Promise<void>;
    }) =>
      visible ? (
        <Pressable onPress={onContinueCloud}>
          <Text>Keep downloading with Cloud</Text>
        </Pressable>
      ) : null,
  };
});
interface MockShellProps {
  ctaLabel: string;
  ctaDisabled?: boolean;
  onCta: () => void;
  secondaryCtaLabel?: string;
  onSecondaryCta?: () => void;
  children?: React.ReactNode;
}
// Just enough shell to press the primary and secondary CTAs by their labels.
jest.mock('@/components/onboarding/OnboardingShell', () => {
  const { Pressable, Text, View } = require('react-native');
  return {
    OnboardingShell: ({
      ctaLabel,
      ctaDisabled,
      onCta,
      secondaryCtaLabel,
      onSecondaryCta,
      children,
    }: MockShellProps) => (
      <View>
        {children}
        <Pressable onPress={onCta} disabled={ctaDisabled} accessibilityRole="button">
          <Text>{ctaLabel}</Text>
        </Pressable>
        {secondaryCtaLabel ? (
          <Pressable onPress={onSecondaryCta} accessibilityRole="button">
            <Text>{secondaryCtaLabel}</Text>
          </Pressable>
        ) : null}
      </View>
    ),
  };
});
jest.mock('@/lib/onboardingMode', () => ({ chooseOnboardingMode: jest.fn(async () => undefined) }));
jest.mock('@/lib/privateMode', () => ({ getPrivateModeUnavailableMessage: () => '' }));
let mockLanguages = ['en'];
jest.mock('@/lib/transcriptionLanguage', () => ({
  getPreferredTranscriptionLanguages: () => mockLanguages,
}));
jest.mock('@/store/useOnboardingStore', () => ({
  useOnboardingStore: (selector: (s: { goNext: () => Promise<void> }) => unknown) =>
    selector({ goNext: jest.fn(async () => undefined) }),
  getStepProgress: () => ({ current: 1, total: 1 }),
}));
jest.mock('@/store/useConfigStore', () => {
  const state = { updateConfig: jest.fn(async () => undefined) };
  return {
    useConfigStore: Object.assign((selector: (s: typeof state) => unknown) => selector(state), {
      getState: () => state,
    }),
  };
});
jest.mock('expo-file-system/legacy', () => ({
  getFreeDiskStorageAsync: jest.fn(async () => 64 * 1024 * 1024 * 1024),
}));
jest.mock('@/services/transcription/LocalWhisperService', () => ({
  LocalWhisperService: {
    isAvailable: jest.fn(() => true),
    downloadModel: jest.fn(async () => undefined),
    cancelModelDownload: jest.fn(async () => undefined),
    deleteModel: jest.fn(async () => undefined),
  },
}));
jest.mock('@/services/transcription/LocalParakeetService', () => ({
  LocalParakeetService: {
    isAvailable: jest.fn(() => true),
    downloadModel: jest.fn(async () => undefined),
    cancelModelDownload: jest.fn(async () => undefined),
    deleteModel: jest.fn(async () => undefined),
    prepare: jest.fn(async () => undefined),
    stagedDownloadBytes: jest.fn(async () => 0),
  },
}));
// English routes to Parakeet v2, which is not installed yet.
jest.mock('@/services/transcription/LocalTranscriptionService', () => ({
  LocalTranscriptionService: {
    isAvailable: jest.fn(() => true),
    getAvailability: jest.fn(async () => ({
      parakeetSupported: true,
      parakeetV2Downloaded: false,
      parakeetV3Downloaded: false,
      whisperDownloaded: false,
    })),
  },
}));

import { chooseOnboardingMode } from '@/lib/onboardingMode';
import { LocalParakeetService } from '@/services/transcription/LocalParakeetService';
import { LocalTranscriptionService } from '@/services/transcription/LocalTranscriptionService';
import {
  useModelDownloadStore,
  type LocalModelKey,
  type ModelDownloadEntry,
} from '@/store/useModelDownloadStore';
import { PrivateDownloadStep } from '../PrivateDownloadStep';

const mockChooseMode = jest.mocked(chooseOnboardingMode);
const realDownloadActions = {
  startDownload: useModelDownloadStore.getState().startDownload,
  cancelDownload: useModelDownloadStore.getState().cancelDownload,
};
const mockStartDownload = jest.fn(async () => undefined);
const mockCancelDownload = jest.fn(async () => undefined);

const setDownload = (key: LocalModelKey, entry: ModelDownloadEntry): void =>
  useModelDownloadStore.setState((state) => ({
    downloads: { ...state.downloads, [key]: entry },
  }));

beforeEach(() => {
  jest.clearAllMocks();
  mockLanguages = ['en'];
  jest.mocked(LocalTranscriptionService.isAvailable).mockReturnValue(true);
  useModelDownloadStore.getState().reset();
  useModelDownloadStore.setState({
    startDownload: mockStartDownload,
    cancelDownload: mockCancelDownload,
  });
});
afterEach(() => jest.useRealTimers());

it('uses the same Cloud choice from the slow-download sheet and keeps the download', async () => {
  jest.useFakeTimers();
  setDownload('parakeet-v2', { status: 'downloading', progress: 0.2 });
  render(<PrivateDownloadStep />);
  await screen.findByText('Parakeet v2');
  await act(async () => {
    jest.advanceTimersByTime(8000);
  });
  await act(async () => {
    fireEvent.press(screen.getByText('Keep downloading with Cloud'));
  });
  expect(mockChooseMode).toHaveBeenCalledWith('cloud', 'private-download');
  expect(mockCancelDownload).not.toHaveBeenCalled();
});

it('uses the same Cloud choice when local recording is unavailable', async () => {
  jest.mocked(LocalTranscriptionService.isAvailable).mockReturnValue(false);
  render(<PrivateDownloadStep />);
  fireEvent.press(screen.getByText('Use Cloud instead'));
  await waitFor(() => expect(mockChooseMode).toHaveBeenCalledWith('cloud', 'private-download'));
});

it('uses the same Cloud choice when model discovery fails', async () => {
  jest
    .mocked(LocalTranscriptionService.getAvailability)
    .mockRejectedValueOnce(new Error('Unavailable'));
  render(<PrivateDownloadStep />);
  fireEvent.press(await screen.findByText('Use Cloud instead'));
  await waitFor(() => expect(mockChooseMode).toHaveBeenCalledWith('cloud', 'private-download'));
});

it('reasserts Local before continuing with a completed model', async () => {
  setDownload('parakeet-v2', { status: 'completed', progress: 1 });
  render(<PrivateDownloadStep />);
  fireEvent.press(await screen.findByText('Continue with Private'));
  await waitFor(() => expect(mockChooseMode).toHaveBeenCalledWith('private', 'private-download'));
});

describe('PrivateDownloadStep — switching to Cloud', () => {
  // A failed attempt leaves its partial download staged. Leaving Private behind is the last
  // chance to reclaim that storage, since only installed models get a delete button.
  it('reclaims the staged partial download when switching to Cloud after an error', async () => {
    setDownload('parakeet-v2', { status: 'error', progress: 0.4, error: 'Network lost' });
    render(<PrivateDownloadStep />);
    await screen.findByText('Parakeet v2');

    fireEvent.press(screen.getByText("Don't use Private — switch to Cloud"));

    await waitFor(() => expect(mockCancelDownload).toHaveBeenCalledWith('parakeet-v2'));
    expect(mockChooseMode).toHaveBeenCalledWith('cloud', 'private-download');
  });

  it('keeps a completed model when switching to Cloud', async () => {
    setDownload('parakeet-v2', { status: 'completed', progress: 1 });
    render(<PrivateDownloadStep />);
    await screen.findByText('Parakeet v2');

    fireEvent.press(screen.getByText('Use Cloud instead'));

    await waitFor(() => expect(mockChooseMode).toHaveBeenCalledWith('cloud', 'private-download'));
    expect(mockCancelDownload).not.toHaveBeenCalled();
  });
});

describe('PrivateDownloadStep — retrying after an error', () => {
  // The auto-start effect only fires once, from idle, so a failed download would otherwise
  // strand the user with a disabled Continue and no way forward but Cloud.
  it('restarts the download from the Try again link', async () => {
    setDownload('parakeet-v2', { status: 'error', progress: 0.4, error: 'Network lost' });
    render(<PrivateDownloadStep />);

    fireEvent.press(await screen.findByText('Try again'));

    expect(mockStartDownload).toHaveBeenCalledWith('parakeet-v2');
  });

  it('does not offer a retry while the download is running', async () => {
    setDownload('parakeet-v2', { status: 'downloading', progress: 0.4 });
    render(<PrivateDownloadStep />);
    await screen.findByText('Parakeet v2');

    expect(screen.queryByText('Try again')).toBeNull();
  });
});

it('offers retry when model discovery fails instead of spinning forever', async () => {
  jest
    .mocked(LocalTranscriptionService.getAvailability)
    .mockRejectedValueOnce(new Error('Model lookup failed'));
  render(<PrivateDownloadStep />);
  fireEvent.press(await screen.findByText('Retry model selection'));
  expect(await screen.findByText('Parakeet v2')).toBeTruthy();
});

// Back → a language change → Continue re-enters with a different recommendation while the old
// one is still transferring. startDownload refuses to run beside it, which used to leave the
// step on a download that never started.
it('replaces a stale download when going back changed the recommended model', async () => {
  useModelDownloadStore.setState(realDownloadActions);
  setDownload('parakeet-v2', { status: 'downloading', progress: 0.3 });
  mockLanguages = ['en', 'es'];

  render(<PrivateDownloadStep />);

  await screen.findByText('Parakeet v3');
  await waitFor(() =>
    expect(LocalParakeetService.downloadModel).toHaveBeenCalledWith('v3', expect.any(Function)),
  );
  expect(LocalParakeetService.cancelModelDownload).toHaveBeenCalledWith('v2');
  expect(useModelDownloadStore.getState().downloads['parakeet-v2'].status).toBe('idle');
});

it('stops a stale download even when the new recommendation is already installed', async () => {
  useModelDownloadStore.setState(realDownloadActions);
  setDownload('parakeet-v2', { status: 'downloading', progress: 0.3 });
  mockLanguages = ['en', 'es'];
  jest.mocked(LocalTranscriptionService.getAvailability).mockResolvedValueOnce({
    parakeetSupported: true,
    parakeetV2Downloaded: false,
    parakeetV3Downloaded: true,
    whisperDownloaded: false,
  });

  render(<PrivateDownloadStep />);

  await screen.findByText('Continue with Private');
  await waitFor(() =>
    expect(useModelDownloadStore.getState().downloads['parakeet-v2'].status).toBe('idle'),
  );
  expect(LocalParakeetService.downloadModel).not.toHaveBeenCalled();
});

it('does not start the new download once the user has left the step', async () => {
  useModelDownloadStore.setState(realDownloadActions);
  setDownload('parakeet-v2', { status: 'downloading', progress: 0.3 });
  mockLanguages = ['en', 'es'];
  let finishCancel!: () => void;
  jest
    .mocked(LocalParakeetService.cancelModelDownload)
    .mockImplementationOnce(() => new Promise<void>((resolve) => (finishCancel = resolve)));

  const view = render(<PrivateDownloadStep />);
  await waitFor(() => expect(LocalParakeetService.cancelModelDownload).toHaveBeenCalledWith('v2'));
  view.unmount();
  await act(async () => finishCancel());

  expect(LocalParakeetService.downloadModel).not.toHaveBeenCalled();
});
