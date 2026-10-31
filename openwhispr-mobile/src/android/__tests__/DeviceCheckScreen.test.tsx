import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { AppState } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import DeviceCheckScreen from '../DeviceCheckScreen';
import { runLocalBenchmark } from '../deviceCheck';
let mockBlur: (() => void) | undefined;
let mockListeners = new Set<(state: string) => void>();
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn() },
  useFocusEffect: (callback: () => () => void) => {
    require('react').useEffect(() => {
      mockBlur = callback();
      return mockBlur;
    }, [callback]);
  },
}));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/store/useConfigStore', () => ({ useConfigStore: () => ({}) }));
jest.mock('@/store/useAuthStore', () => ({ useAuthStore: { subscribe: () => jest.fn() } }));
jest.mock('expo-document-picker', () => ({ getDocumentAsync: jest.fn() }));
jest.mock('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///cache/',
  getInfoAsync: jest.fn(async () => ({ exists: true, size: 50 })),
  deleteAsync: jest.fn(async () => {}),
}));
jest.mock('../models', () => ({
  ANDROID_MODELS: { 'parakeet-v3': { title: 'Parakeet' }, 'qwen-balanced': { title: 'Qwen' } },
}));
jest.mock('../deviceCheck', () => ({
  readDeviceProfile: () => null,
  snapshotBenchmark: () => ({ speech: 'parakeet-v3', text: 'qwen-small' }),
  validateBenchmark: jest.fn(async () => {}),
  deviceGuidance: () => 'deviceTestFirst',
  runLocalBenchmark: jest.fn(),
}));
jest.mock('../ui', () => ({
  Page: ({ children }: any) => children,
  Card: ({ children }: any) => children,
  Row: () => null,
  styles: {},
  palette: {},
  Button: ({ label, onPress, disabled }: any) =>
    require('react').createElement(
      require('react-native').Pressable,
      { onPress, disabled, accessibilityRole: 'button', accessibilityLabel: label },
      require('react').createElement(require('react-native').Text, null, label),
    ),
}));
beforeEach(() => {
  jest.clearAllMocks();
  mockListeners = new Set();
  Object.defineProperty(AppState, 'currentState', {
    configurable: true,
    writable: true,
    value: 'active',
  });
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, listener: any) => {
    mockListeners.add(listener);
    return { remove: () => mockListeners.delete(listener) };
  });
  jest.mocked(runLocalBenchmark).mockRejectedValue(new Error('Test stopped'));
});
function emit(state: 'active' | 'background') {
  Object.defineProperty(AppState, 'currentState', {
    configurable: true,
    writable: true,
    value: state,
  });
  for (const listener of mockListeners) listener(state);
}
it('waits for the foreground before starting work after a late picker response', async () => {
  let resolve!: (value: any) => void;
  jest.mocked(DocumentPicker.getDocumentAsync).mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  render(<DeviceCheckScreen />);
  await act(async () => {
    fireEvent.press(screen.getByRole('button', { name: 'benchmarkStart' }));
  });
  act(() => emit('background'));
  await act(async () => {
    resolve({ canceled: false, assets: [{ uri: 'file:///cache/sample.wav' }] });
  });
  expect(runLocalBenchmark).not.toHaveBeenCalled();
  await act(async () => emit('active'));
  expect(runLocalBenchmark).toHaveBeenCalledTimes(1);
  expect(FileSystem.deleteAsync).toHaveBeenCalledWith('file:///cache/sample.wav', {
    idempotent: true,
  });
});
it('cleans a late picker copy after leaving without starting inference', async () => {
  let resolve!: (value: any) => void;
  jest.mocked(DocumentPicker.getDocumentAsync).mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  render(<DeviceCheckScreen />);
  await act(async () => {
    fireEvent.press(screen.getByRole('button', { name: 'benchmarkStart' }));
  });
  act(() => mockBlur?.());
  await act(async () => {
    resolve({ canceled: false, assets: [{ uri: 'file:///cache/sample.wav' }] });
  });
  expect(runLocalBenchmark).not.toHaveBeenCalled();
  expect(FileSystem.deleteAsync).toHaveBeenCalledWith('file:///cache/sample.wav', {
    idempotent: true,
  });
});
it('does not delete an original file returned outside app cache', async () => {
  jest.mocked(DocumentPicker.getDocumentAsync).mockResolvedValueOnce({
    canceled: false,
    assets: [
      { uri: 'file:///original.wav', name: 'sample', mimeType: 'audio/wav', lastModified: 0 },
    ],
  });
  render(<DeviceCheckScreen />);
  await act(async () => {
    fireEvent.press(screen.getByRole('button', { name: 'benchmarkStart' }));
  });
  expect(FileSystem.deleteAsync).not.toHaveBeenCalled();
});
