import React from 'react';
import { Alert } from 'react-native';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

let mockActiveMode = 'private';
jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/store/useConfigStore', () => ({ useConfigStore: () => ({}) }));
jest.mock('@/store/useProcessingModeStore', () => ({
  useProcessingModeStore: (selector: (state: { activeMode: string }) => unknown) =>
    selector({ activeMode: mockActiveMode }),
}));
jest.mock('@/lib/workflowModeSwitch', () => ({ setPrivateMode: jest.fn() }));
let mockReady = false;
let mockProgress: Record<string, number> = {};
const mockDownload = jest.fn(async (_id: string) => {
  mockReady = true;
});
const mockRemove = jest.fn(async (_id: string) => {
  mockReady = false;
});
const mockCancel = jest.fn(async (_id: string) => undefined);
jest.mock('../models', () => ({
  ANDROID_MODELS: {
    'meeting-speakers': { kind: 'diarization', title: 'Meeting speakers', bytes: 41797789 },
    'qwen-cleanup': { kind: 'text', title: 'Qwen3 4B', bytes: 2497281120 },
    'qwen-balanced': { kind: 'text', title: 'Qwen3 1.7B', bytes: 1107409472 },
  },
  useModelDownloads: (selector: (state: unknown) => unknown) =>
    selector({ progress: mockProgress }),
  modelReady: async () => mockReady,
  modelSupported: () => true,
  downloadAndroidModel: (id: string) => mockDownload(id),
  removeAndroidModel: (id: string) => mockRemove(id),
  cancelAndroidDownload: (id: string) => mockCancel(id),
}));
jest.mock('../ui', () => {
  const { View, Pressable, Text } = require('react-native');
  return {
    Page: View,
    Card: View,
    Row: ({ title, detail, onPress }: { title: string; detail: string; onPress: () => void }) =>
      require('react').createElement(
        Pressable,
        { onPress },
        require('react').createElement(Text, null, title),
        require('react').createElement(Text, null, detail),
      ),
    Button: ({ label, ...props }: { label: string }) =>
      require('react').createElement(
        Pressable,
        props,
        require('react').createElement(Text, null, label),
      ),
    styles: {},
  };
});

import { ModelsContent } from '../ModelsScreen';
import { setPrivateMode } from '@/lib/workflowModeSwitch';

beforeEach(() => {
  jest.clearAllMocks();
  mockReady = false;
  mockProgress = {};
  mockActiveMode = 'private';
  jest.mocked(setPrivateMode).mockResolvedValue('switched');
});

it.each([
  ['private', false],
  ['cloud', true],
] as const)('exposes the normal mode switch from %s', async (mode, enabled) => {
  mockActiveMode = mode;
  render(<ModelsContent />);
  const control = screen.getByRole('switch', { name: 'privateMode' });
  expect(control.props.value).toBe(!enabled);
  await act(async () => fireEvent(control, 'valueChange', enabled));
  expect(setPrivateMode).toHaveBeenCalledWith(enabled);
});

it('keeps the selected mode and enables retry after a switch fails', async () => {
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  jest.mocked(setPrivateMode).mockRejectedValue(new Error('Unable to switch mode'));
  render(<ModelsContent />);
  await act(async () =>
    fireEvent(screen.getByRole('switch', { name: 'privateMode' }), 'valueChange', false),
  );
  await waitFor(() =>
    expect(Alert.alert).toHaveBeenCalledWith('errorTitle', 'Unable to switch mode', [
      { text: 'close' },
    ]),
  );
  const control = screen.getByRole('switch', { name: 'privateMode' });
  expect(control.props.value).toBe(true);
  expect(control.props.disabled).toBe(false);
});

it('offers a translated dismissal after a failed download and allows retry', async () => {
  jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  mockDownload.mockRejectedValueOnce(new Error('Localized download failure'));
  const view = render(<ModelsContent />);
  await act(async () => undefined);
  fireEvent.press(view.getByText('Meeting speakers'));
  await act(async () => fireEvent.press(view.getByText('download')));
  expect(Alert.alert).toHaveBeenCalledWith('errorTitle', 'Localized download failure', [
    { text: 'close' },
  ]);
  expect(view.queryByText('removeModel')).toBeNull();
  await act(async () => fireEvent.press(view.getByText('download')));
  expect(mockDownload).toHaveBeenCalledTimes(2);
  expect(view.getByText('removeModel')).toBeTruthy();
});

it('offers the 42 MB speaker package for download and removal without choosing it as speech', async () => {
  jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  const view = render(<ModelsContent />);
  await act(async () => undefined);
  expect(view.getByText('42 MB')).toBeTruthy();
  fireEvent.press(view.getByText('Meeting speakers'));
  await act(async () => fireEvent.press(view.getByText('download')));
  expect(mockDownload).toHaveBeenCalledWith('meeting-speakers');
  expect(view.queryByText('choose')).toBeNull();
  expect(view.queryByText('selected')).toBeNull();
  fireEvent.press(view.getByText('removeModel'));
  const buttons = jest.mocked(Alert.alert).mock.calls.at(-1)?.[2];
  await act(async () => buttons?.find((button) => button.style === 'destructive')?.onPress?.());
  expect(mockRemove).toHaveBeenCalledWith('meeting-speakers');
});
it('allows cancelling the speaker-model download', async () => {
  mockProgress = { 'meeting-speakers': 0.4 };
  const view = render(<ModelsContent />);
  await act(async () => fireEvent.press(view.getByText('cancel')));
  expect(mockCancel).toHaveBeenCalledWith('meeting-speakers');
});

it('manages the fixed cleanup model without offering it as a global text selection', async () => {
  jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  const view = render(<ModelsContent />);
  await act(async () => undefined);
  expect(view.getByText('2497 MB · cleanup')).toBeTruthy();
  fireEvent.press(view.getByText('Qwen3 4B'));
  await act(async () => fireEvent.press(view.getByText('download')));
  expect(mockDownload).toHaveBeenCalledWith('qwen-cleanup');
  expect(view.queryByText('choose')).toBeNull();
  fireEvent.press(view.getByText('removeModel'));
  const buttons = jest.mocked(Alert.alert).mock.calls.at(-1)?.[2];
  await act(async () => buttons?.find((button) => button.style === 'destructive')?.onPress?.());
  expect(mockRemove).toHaveBeenCalledWith('qwen-cleanup');
});

it('labels legacy text choices by their roles rather than recommending them for cleanup', async () => {
  const view = render(<ModelsContent />);
  await act(async () => undefined);
  fireEvent.press(view.getByText('Qwen3 1.7B'));
  expect(view.getByText('notes · assistant · translate · edit')).toBeTruthy();
  expect(view.queryByText('modelIntro')).toBeNull();
});
