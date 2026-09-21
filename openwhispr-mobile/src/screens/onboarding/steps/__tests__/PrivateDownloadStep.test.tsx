import type React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

// nativewind's cssInterop breaks jest's transform; same stub the other screen suites use.
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('../SlowDownloadSheet', () => ({ SlowDownloadSheet: () => null }));
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
jest.mock('@/lib/privateMode', () => ({ getPrivateModeUnavailableMessage: () => '' }));
jest.mock('@/lib/transcriptionLanguage', () => ({
  getPreferredTranscriptionLanguages: () => ['en'],
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

import { useConfigStore } from '@/store/useConfigStore';
import {
  useModelDownloadStore,
  type LocalModelKey,
  type ModelDownloadEntry,
} from '@/store/useModelDownloadStore';
import { PrivateDownloadStep } from '../PrivateDownloadStep';

const mockUpdateConfig = useConfigStore.getState().updateConfig as jest.Mock;
const mockStartDownload = jest.fn(async () => undefined);
const mockCancelDownload = jest.fn(async () => undefined);

const setDownload = (key: LocalModelKey, entry: ModelDownloadEntry): void =>
  useModelDownloadStore.setState((state) => ({
    downloads: { ...state.downloads, [key]: entry },
  }));

beforeEach(() => {
  jest.clearAllMocks();
  useModelDownloadStore.getState().reset();
  useModelDownloadStore.setState({
    startDownload: mockStartDownload,
    cancelDownload: mockCancelDownload,
  });
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
    expect(mockUpdateConfig).toHaveBeenCalledWith({ defaultMode: 'cloud' });
  });

  it('keeps a completed model when switching to Cloud', async () => {
    setDownload('parakeet-v2', { status: 'completed', progress: 1 });
    render(<PrivateDownloadStep />);
    await screen.findByText('Parakeet v2');

    fireEvent.press(screen.getByText('Use Cloud instead'));

    await waitFor(() => expect(mockUpdateConfig).toHaveBeenCalledWith({ defaultMode: 'cloud' }));
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
