import React from 'react';
import { act, render, waitFor } from '@testing-library/react-native';

const mockNote = {
  id: 81,
  noteType: 'meeting',
  transcriptionStatus: 'recording',
  createdAt: '2026-01-01 00:00:00',
  sourceFile: 'file:///docs/meeting-81.wav',
};
let mockNotesLoaded = false;
let mockResolveAuth: () => void;
const mockAuth = new Promise<void>((resolve) => {
  mockResolveAuth = resolve;
});
const mockResume = jest.fn();
const mockInitializeNotes = jest.fn(() => {
  mockNotesLoaded = true;
});
const mockTransition = jest.fn((_id: number, status: string) => {
  mockNote.transcriptionStatus = status;
});
jest.mock('@/android/strings', () => ({ observeAndroidLanguage: () => () => {} }));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
// A cold deep link mounts its destination, without mounting Home/useAppInit.
jest.mock('expo-router', () => ({ Stack: () => null }));
jest.mock('expo-status-bar', () => ({ StatusBar: () => null }));
jest.mock('expo-font', () => ({ useFonts: () => [true, null] }));
jest.mock('@expo-google-fonts/space-grotesk', () => ({}));
jest.mock('expo-splash-screen', () => ({ hideAsync: async () => {} }));
jest.mock('react-native-gesture-handler', () => ({
  GestureHandlerRootView: require('react-native').View,
}));
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaProvider: require('react-native').View,
}));
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: { getState: () => ({ loadConfig: async () => {} }) },
}));
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: { getState: () => ({ initialize: () => mockAuth }) },
}));
jest.mock('@/store/useTranscriptStore', () => ({
  useTranscriptStore: { getState: () => ({ loadTranscripts: async () => {} }) },
}));
jest.mock('@/store/useDictionaryStore', () => ({
  useDictionaryStore: { getState: () => ({ load: async () => {} }) },
}));
jest.mock('@/store/useSnippetsStore', () => ({
  useSnippetsStore: { getState: () => ({ load: async () => {} }) },
}));
jest.mock('@/store/useNotesStore', () => ({
  useNotesStore: {
    getState: () => ({
      initialize: mockInitializeNotes,
      transitionStatus: mockTransition,
      retryMeetingTranscription: mockResume,
    }),
  },
}));
jest.mock('@/sync/syncEngine', () => ({ initSyncTriggers: jest.fn() }));
jest.mock('@/components/ui/PermissionAlert', () => ({ PermissionAlertMount: () => null }));
jest.mock('@/components/superwall/OpenWhisprSuperwallProvider', () => ({
  OpenWhisprSuperwallProvider: require('react-native').View,
}));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/OpenWhisprMark', () => ({ OpenWhisprMark: () => null }));
jest.mock('@/android/ui', () => ({ Button: () => null, styles: {}, palette: {} }));
jest.mock('@/hooks/useRevenueCatIdentity', () => ({ useRevenueCatIdentity: () => {} }));
jest.mock('@/android/billing', () => ({ observeAndroidPurchaseUpdates: () => () => {} }));
jest.mock('@/android/useBubblePipeline', () => ({ useBubblePipeline: () => {} }));
jest.mock('expo-sqlite/localStorage/install', () => ({}));
jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///docs/',
  readDirectoryAsync: async () => ['meeting-81.wav'],
}));
jest.mock('@/data', () => ({
  notesRepository: {
    getNoteById: () => mockNote,
    getAllNotes: () => {
      if (!mockNotesLoaded) throw new Error('Recovery ran before notes initialized');
      return [mockNote];
    },
  },
}));
jest.mock('@/lib/sentry', () => ({ Sentry: { captureException: jest.fn() } }));
jest.mock('@/lib/transcriptAudio', () => ({
  isManagedMeetingAudioUri: (id: number, uri?: string) => uri === `file:///docs/meeting-${id}.wav`,
}));

import AndroidRoot from '../Root';

it('recovers a killed recording on a cold Notes deep link after auth, without Home or automatic upload', async () => {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: () => null, setItem: jest.fn(), removeItem: jest.fn() },
  });
  const view = render(<AndroidRoot />);
  expect(mockInitializeNotes).not.toHaveBeenCalled();
  expect(mockNote.transcriptionStatus).toBe('recording');
  await act(async () => mockResolveAuth());
  await waitFor(() => expect(mockNote.transcriptionStatus).toBe('failed'));
  expect(mockInitializeNotes).toHaveBeenCalledTimes(1);
  expect(mockTransition).toHaveBeenCalledWith(81, 'failed');
  expect(mockNote.sourceFile).toBe('file:///docs/meeting-81.wav');
  expect(mockResume).not.toHaveBeenCalled();
  view.rerender(<AndroidRoot />);
  expect(mockTransition).toHaveBeenCalledTimes(1);
});
