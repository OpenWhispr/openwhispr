import React from 'react';
import { act, fireEventAsync, renderAsync, screen } from '@testing-library/react-native';

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
    getAvailability: jest.fn(async () => ({
      parakeetSupported: true,
      parakeetV2Downloaded: false,
      parakeetV3Downloaded: false,
      whisperDownloaded: true,
      orukeetSupported: true,
      orukeetDownloaded: false,
    })),
  },
}));

import { LocalParakeetService } from '@/services/transcription/LocalParakeetService';
import {
  useModelDownloadStore,
  type LocalModelKey,
  type ModelDownloadStatus,
} from '@/store/useModelDownloadStore';
import ModelDownloadScreen from '../ModelDownloadScreen';

const mockParakeet = LocalParakeetService as jest.Mocked<typeof LocalParakeetService>;
const MB = 1024 * 1024;

const setDownloadStatus = (key: LocalModelKey, status: ModelDownloadStatus): void =>
  useModelDownloadStore.setState((state) => ({
    downloads: { ...state.downloads, [key]: { ...state.downloads[key], status } },
  }));

beforeEach(() => {
  jest.clearAllMocks();
  useModelDownloadStore.getState().reset();
  mockParakeet.stagedDownloadBytes.mockResolvedValue(0);
});

// A failed or interrupted Parakeet attempt keeps up to ~445 MB staged for the next try. The
// delete button only exists for installed models, so without this action a user who gives up on
// Parakeet has no visible way to get that storage back.
describe('ModelDownloadScreen — partial Parakeet download', () => {
  // Renders, presses and store updates all settle inside async act (renderAsync, fireEventAsync,
  // act(async)), which keeps flushing until the mocked promise chains stop scheduling updates, so
  // every assertion sees the settled screen. findByText/waitFor would instead poll on real timers
  // against a 1 s budget, and under CPU load the event loop can stall past it before the render
  // that shows or removes the link commits.

  it('offers to clear a staged partial download and reclaims it on confirm', async () => {
    mockParakeet.stagedDownloadBytes.mockImplementation(async (version) =>
      version === 'v2' ? 445 * MB : 0,
    );
    await renderAsync(<ModelDownloadScreen />);

    const action = screen.getByText(/Clear partial download \(445\.0 MB\)/);
    expect(screen.getAllByText(/Clear partial download/)).toHaveLength(1);

    mockParakeet.stagedDownloadBytes.mockResolvedValue(0);
    await fireEventAsync.press(action);

    expect(mockParakeet.cancelModelDownload).toHaveBeenCalledWith('v2');
    expect(screen.queryByText(/Clear partial download/)).not.toBeOnTheScreen();
  });

  it('shows nothing when no partial download is staged', async () => {
    await renderAsync(<ModelDownloadScreen />);

    expect(screen.getByText('Parakeet v2')).toBeTruthy();
    expect(screen.queryByText(/Clear partial download/)).toBeNull();
  });

  // Staged bytes are only re-read between transfers, so while another model downloads the label
  // would be stale — and clearing mid-transfer is not something the user should be offered.
  it('hides the clear link while another model is downloading', async () => {
    mockParakeet.stagedDownloadBytes.mockImplementation(async (version) =>
      version === 'v2' ? 445 * MB : 0,
    );
    await renderAsync(<ModelDownloadScreen />);
    expect(screen.getByText(/Clear partial download \(445\.0 MB\)/)).toBeTruthy();

    await act(async () => setDownloadStatus('parakeet-v3', 'downloading'));
    expect(screen.queryByText(/Clear partial download/)).toBeNull();

    await act(async () => setDownloadStatus('parakeet-v3', 'idle'));
    expect(screen.getByText(/Clear partial download \(445\.0 MB\)/)).toBeTruthy();
  });

  // The red link alone reads as "something went wrong"; the row should also say the kept bytes
  // are an asset the next attempt picks up from.
  it('explains that staged bytes will be reused by the next attempt', async () => {
    mockParakeet.stagedDownloadBytes.mockImplementation(async (version) =>
      version === 'v2' ? 445 * MB : 0,
    );
    await renderAsync(<ModelDownloadScreen />);

    expect(screen.getByText('445.0 MB saved from an earlier attempt will be reused.')).toBeTruthy();
    expect(screen.getAllByText(/saved from an earlier attempt/)).toHaveLength(1);
  });

  it('does not mention reuse when nothing is staged', async () => {
    await renderAsync(<ModelDownloadScreen />);

    expect(screen.getByText('Parakeet v2')).toBeTruthy();
    expect(screen.queryByText(/saved from an earlier attempt/)).toBeNull();
  });
});
