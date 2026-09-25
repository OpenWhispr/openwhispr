import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';

const mockPush = jest.fn();
const mockPickLocalModel = jest.fn().mockResolvedValue(undefined);
let mockLanguages: string[] = ['en'];
let mockAvailability = {
  parakeetSupported: true,
  parakeetV2Downloaded: true,
  parakeetV3Downloaded: true,
  whisperDownloaded: false,
};

jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('expo-router', () => ({
  router: { push: (...args: unknown[]) => mockPush(...args) },
  useFocusEffect: (effect: () => void) => require('react').useEffect(effect, [effect]),
}));
jest.mock('@/store/useModelDownloadStore', () => ({
  useModelDownloadStore: (selector: (state: unknown) => unknown) => selector({ completedCount: 0 }),
}));
jest.mock('@/lib/transcriptionLanguage', () => ({
  getPreferredTranscriptionLanguages: () => mockLanguages,
}));
jest.mock('@/services/transcription/LocalTranscriptionService', () => ({
  LocalTranscriptionService: { getAvailability: async () => mockAvailability },
}));
jest.mock('@/lib/workflowModeSwitch', () => ({
  pickLocalModel: (...args: unknown[]) => mockPickLocalModel(...args),
}));

import { OnDeviceModelSection } from '../OnDeviceModelSection';

function isSelected(title: string): boolean {
  let row = screen.getByText(title).parent;
  while (row && !row.props.accessibilityState) row = row.parent;
  return !!row?.props.accessibilityState?.selected;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockLanguages = ['en'];
  mockAvailability = {
    parakeetSupported: true,
    parakeetV2Downloaded: true,
    parakeetV3Downloaded: true,
    whisperDownloaded: false,
  };
});

it('offers the language list for multi-language models only', async () => {
  render(<OnDeviceModelSection scope="dictation" picked={undefined} />);
  await screen.findByText('Parakeet v3');
  expect(screen.getByLabelText('Parakeet v3 languages')).toBeTruthy();
  expect(screen.getByLabelText('Whisper base languages')).toBeTruthy();
  expect(screen.queryByLabelText('Parakeet v2 languages')).toBeNull();
});

it('defaults to Automatic and names the model it is using', async () => {
  render(<OnDeviceModelSection scope="dictation" picked={undefined} />);
  expect(await screen.findByText(/Using Parakeet v2/)).toBeTruthy();
  expect(isSelected('Automatic')).toBe(true);
});

it('picks a downloaded model for the workflow', async () => {
  render(<OnDeviceModelSection scope="upload" picked={undefined} />);
  fireEvent.press(await screen.findByText('Parakeet v3'));
  expect(mockPickLocalModel).toHaveBeenCalledWith('upload', 'parakeet-v3');
});

it('shows the picked model as selected and can go back to Automatic', async () => {
  render(<OnDeviceModelSection scope="dictation" picked="parakeet-v3" />);
  await screen.findByText('Parakeet v3');
  expect(isSelected('Parakeet v3')).toBe(true);
  expect(isSelected('Automatic')).toBe(false);
  fireEvent.press(screen.getByText('Automatic'));
  expect(mockPickLocalModel).toHaveBeenCalledWith('dictation', undefined);
});

it('sends a model that is not downloaded to the download screen', async () => {
  render(<OnDeviceModelSection scope="dictation" picked={undefined} />);
  fireEvent.press(await screen.findByText('Whisper base'));
  expect(mockPush).toHaveBeenCalledWith('/(account)/model-download');
  expect(mockPickLocalModel).not.toHaveBeenCalled();
});

it('does not let a model that misses a language be picked, and falls back to Automatic', async () => {
  mockLanguages = ['fr'];
  render(<OnDeviceModelSection scope="dictation" picked="parakeet-v2" />);
  expect(await screen.findByText(/Doesn't cover your languages/)).toBeTruthy();
  fireEvent.press(screen.getByText('Parakeet v2'));
  expect(mockPickLocalModel).not.toHaveBeenCalled();
  expect(isSelected('Automatic')).toBe(true);
});
