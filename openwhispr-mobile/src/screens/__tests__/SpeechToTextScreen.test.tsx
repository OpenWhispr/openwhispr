import React from 'react';
import { Alert } from 'react-native';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import SpeechToTextScreen from '../SpeechToTextScreen';

const mockPush = jest.fn();
const mockUpdateConfig = jest.fn();
const mockSetActiveMode = jest.fn();
const mockPrivateReadiness = jest.fn();

jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('@/lib/utils', () => ({ safeHaptics: jest.fn() }));
jest.mock('expo-router', () => ({ router: { push: (...args: unknown[]) => mockPush(...args) } }));
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: (selector: (state: unknown) => unknown) =>
    selector({ config: { defaultMode: 'cloud' }, updateConfig: mockUpdateConfig }),
}));
jest.mock('@/store/useProcessingModeStore', () => ({
  useProcessingModeStore: () => ({ activeMode: 'cloud', setActiveMode: mockSetActiveMode }),
}));
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: Object.assign(
    (selector: (state: unknown) => unknown) => selector({ user: { id: 'user-1' } }),
    { getState: () => ({ user: { id: 'user-1' } }) },
  ),
}));
jest.mock('@/lib/privateMode', () => ({
  getPrivateModeReadiness: () => mockPrivateReadiness(),
  getPrivateModeUnavailableMessage: () => 'Unavailable.',
}));

beforeEach(() => jest.clearAllMocks());

it('opens the Dictation workflow with Bring Your Own Key chosen', () => {
  render(<SpeechToTextScreen />);
  fireEvent.press(screen.getByText('Bring Your Own Key'));
  expect(mockPush).toHaveBeenCalledWith({
    pathname: '/(account)/provider-workflow',
    params: { scope: 'dictation', mode: 'providers' },
  });
});

it('asks for the on-device model before switching to On-Device', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  mockPrivateReadiness.mockResolvedValue({ status: 'missing', modelName: 'Parakeet v3' });
  render(<SpeechToTextScreen />);
  fireEvent.press(screen.getByText('On-Device'));
  await waitFor(() => expect(alert).toHaveBeenCalled());
  expect(alert.mock.calls[0][0]).toBe('Download required');
  expect(mockUpdateConfig).not.toHaveBeenCalled();
  alert.mockRestore();
});

it('switches to On-Device once the model is downloaded', async () => {
  mockPrivateReadiness.mockResolvedValue({ status: 'ready', modelName: 'Parakeet v3' });
  render(<SpeechToTextScreen />);
  fireEvent.press(screen.getByText('On-Device'));
  await waitFor(() => expect(mockSetActiveMode).toHaveBeenCalledWith('private', true));
  expect(mockUpdateConfig).toHaveBeenCalledWith(
    expect.objectContaining({
      defaultMode: 'private',
      inference: { dictation: { mode: 'local' } },
    }),
  );
});
