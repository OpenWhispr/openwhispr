import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

jest.mock('expo-router', () => ({
  useRouter: () => ({ canGoBack: () => true, back: jest.fn(), replace: jest.fn() }),
}));
// nativewind's cssInterop breaks jest's transform; same stub the other screen suites use.
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('@/lib/utils', () => ({ safeHaptics: jest.fn() }));
jest.mock('@/lib/transcriptionLanguage', () => ({
  getPreferredTranscriptionLanguages: () => ['en'],
}));
// Confirms straight away: these tests cover what confirming does, not the alert itself.
jest.mock('@/lib/alerts', () => ({
  confirmDestructive: jest.fn((_title: string, _message: string, onConfirm: () => unknown) => {
    onConfirm();
  }),
}));
jest.mock('expo-file-system/legacy', () => ({
  getFreeDiskStorageAsync: jest.fn(async () => 64 * 1024 * 1024 * 1024),
}));
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: { getState: () => ({ updateConfig: jest.fn(async () => undefined) }) },
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
jest.mock('@/services/transcription/LocalTranscriptionService', () => ({
  LocalTranscriptionService: {
    isAvailable: jest.fn(() => true),
    getAvailability: jest.fn(),
  },
}));

import { LocalParakeetService } from '@/services/transcription/LocalParakeetService';
import { LocalTranscriptionService } from '@/services/transcription/LocalTranscriptionService';
import type { LocalEngineAvailability } from '@/services/transcription/localEngine';
import { useModelDownloadStore, type ModelDownloadEntry } from '@/store/useModelDownloadStore';
import ModelDownloadScreen from '../ModelDownloadScreen';

const mockParakeet = LocalParakeetService as jest.Mocked<typeof LocalParakeetService>;
const mockTranscription = LocalTranscriptionService as jest.Mocked<
  typeof LocalTranscriptionService
>;
const MB = 1024 * 1024;

const withAvailability = (overrides: Partial<LocalEngineAvailability> = {}): void => {
  mockTranscription.getAvailability.mockResolvedValue({
    parakeetSupported: true,
    parakeetV2Downloaded: true,
    parakeetV3Downloaded: true,
    whisperDownloaded: true,
    orukeetSupported: true,
    orukeetDownloaded: false,
    ...overrides,
  });
};

const setOrukeetEntry = (entry: Partial<ModelDownloadEntry>): void =>
  useModelDownloadStore.setState((state) => ({
    downloads: { ...state.downloads, orukeet: { ...state.downloads.orukeet, ...entry } },
  }));

beforeEach(() => {
  jest.clearAllMocks();
  useModelDownloadStore.getState().reset();
  mockParakeet.stagedDownloadBytes.mockResolvedValue(0);
  withAvailability();
});

describe('ModelDownloadScreen — Orukeet', () => {
  it('keeps the model picker loading during OS recovery and then shows the installed model', async () => {
    let finishRecovery!: (value: LocalEngineAvailability) => void;
    mockTranscription.getAvailability.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRecovery = resolve;
        }),
    );
    render(<ModelDownloadScreen />);

    await screen.findByText('Loading models…');
    expect(mockTranscription.getAvailability).toHaveBeenCalledWith({ waitForRecovery: true });
    expect(screen.queryByLabelText('Download Orukeet')).toBeNull();
    await act(async () =>
      finishRecovery({
        parakeetSupported: true,
        parakeetV2Downloaded: true,
        parakeetV3Downloaded: true,
        whisperDownloaded: true,
        orukeetSupported: true,
        orukeetDownloaded: true,
      }),
    );
    await screen.findByLabelText('Delete Orukeet');
    expect(screen.queryByLabelText('Download Orukeet')).toBeNull();
    expect(mockParakeet.downloadModel).not.toHaveBeenCalled();
  });

  it('lists Orukeet without taking the Recommended badge from Parakeet', async () => {
    render(<ModelDownloadScreen />);

    await screen.findByText('Orukeet');
    expect(screen.getAllByText('Recommended')).toHaveLength(1);
  });

  it('marks the one model dictation runs on as in use', async () => {
    withAvailability({ orukeetDownloaded: true });
    render(<ModelDownloadScreen />);

    await screen.findByText('Orukeet');
    expect(screen.getAllByText('In use')).toHaveLength(1);
  });

  it('cancels an Orukeet download that is still in flight', async () => {
    render(<ModelDownloadScreen />);
    await screen.findByText('Orukeet');

    act(() => setOrukeetEntry({ status: 'downloading', progress: 0.4 }));
    fireEvent.press(screen.getByLabelText('Cancel Orukeet download'));

    await waitFor(() => expect(mockParakeet.cancelModelDownload).toHaveBeenCalledWith('orukeet'));
    await waitFor(() =>
      expect(useModelDownloadStore.getState().downloads.orukeet.status).toBe('idle'),
    );
  });

  it('deletes Orukeet itself, never the Parakeet v3 it shares a runtime with', async () => {
    withAvailability({ orukeetDownloaded: true });
    render(<ModelDownloadScreen />);

    fireEvent.press(await screen.findByLabelText('Delete Orukeet'));

    await waitFor(() => expect(mockParakeet.deleteModel).toHaveBeenCalledWith('orukeet'));
    expect(mockParakeet.deleteModel).not.toHaveBeenCalledWith('v3');
  });

  it('offers to clear an archive an interrupted Orukeet download left staged', async () => {
    mockParakeet.stagedDownloadBytes.mockImplementation(async (version) =>
      version === 'orukeet' ? 530 * MB : 0,
    );
    render(<ModelDownloadScreen />);

    fireEvent.press(await screen.findByText(/Clear partial download \(530\.0 MB\)/));

    await waitFor(() => expect(mockParakeet.cancelModelDownload).toHaveBeenCalledWith('orukeet'));
  });

  it('shows verification, then the one-time preparation, while Orukeet installs', async () => {
    render(<ModelDownloadScreen />);
    await screen.findByText('Orukeet');

    act(() => setOrukeetEntry({ status: 'preparing', progress: 1, installPhase: 'verifying' }));
    expect(screen.getByText('Verifying download…')).toBeTruthy();

    act(() => setOrukeetEntry({ installPhase: 'compiling' }));
    expect(screen.queryByText('Verifying download…')).toBeNull();
    expect(screen.getByText('Preparing model for your device… (one time)')).toBeTruthy();
  });
});
