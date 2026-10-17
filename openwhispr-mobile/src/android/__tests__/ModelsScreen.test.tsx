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
jest.mock('../models', () => ({ ANDROID_MODELS: {}, useModelDownloads: () => ({}) }));
jest.mock('../ui', () => {
  const { View } = require('react-native');
  return { Page: View, Card: View, Row: () => null, Button: () => null, styles: {} };
});

import { ModelsContent } from '../ModelsScreen';
import { setPrivateMode } from '@/lib/workflowModeSwitch';

beforeEach(() => {
  jest.clearAllMocks();
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
    expect(Alert.alert).toHaveBeenCalledWith('errorTitle', 'Unable to switch mode'),
  );
  const control = screen.getByRole('switch', { name: 'privateMode' });
  expect(control.props.value).toBe(true);
  expect(control.props.disabled).toBe(false);
});
