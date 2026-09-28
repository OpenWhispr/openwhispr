import React from 'react';
import { AppState, Linking } from 'react-native';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

const mockGetStatus = jest.fn();
const mockRequest = jest.fn();
const mockSetDictationMode = jest.fn();

jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('@/lib/notifications', () => ({
  getNotificationStatus: () => mockGetStatus(),
  requestNotifications: () => mockRequest(),
}));
jest.mock('../../../modules/live-activity/src', () => ({
  LiveActivity: {
    isDictationModeEnabled: () => false,
    setDictationMode: (enabled: boolean) => mockSetDictationMode(enabled),
  },
}));

import {
  HardwareKeyboardShortcutScreen,
  SHORTCUTS_APP_URL,
  SHORTCUTS_CREATE_URL,
} from '../HardwareKeyboardShortcutScreen';

beforeEach(() => {
  jest.clearAllMocks();
  mockGetStatus.mockResolvedValue('granted');
  jest.spyOn(AppState, 'addEventListener').mockReturnValue({ remove: jest.fn() } as never);
  jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
  jest.spyOn(Linking, 'openSettings').mockResolvedValue(undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('HardwareKeyboardShortcutScreen', () => {
  it('opens the Shortcuts editor for step 2', async () => {
    render(<HardwareKeyboardShortcutScreen />);
    fireEvent.press(screen.getByText('Open Shortcuts'));
    expect(Linking.openURL).toHaveBeenCalledWith(SHORTCUTS_CREATE_URL);
    await waitFor(() => expect(mockGetStatus).toHaveBeenCalled());
  });

  it('falls back to the Shortcuts app when the editor link cannot open', async () => {
    (Linking.openURL as jest.Mock)
      .mockRejectedValueOnce(new Error('Unable to open URL: shortcuts://create-shortcut'))
      .mockResolvedValueOnce(true);
    render(<HardwareKeyboardShortcutScreen />);
    await act(async () => {
      fireEvent.press(screen.getByText('Open Shortcuts'));
    });
    expect(Linking.openURL).toHaveBeenNthCalledWith(1, SHORTCUTS_CREATE_URL);
    expect(Linking.openURL).toHaveBeenNthCalledWith(2, SHORTCUTS_APP_URL);
  });

  it('does not throw when Shortcuts cannot be opened at all', async () => {
    (Linking.openURL as jest.Mock).mockRejectedValue(new Error('Unable to open URL'));
    render(<HardwareKeyboardShortcutScreen />);
    await act(async () => {
      fireEvent.press(screen.getByText('Open Shortcuts'));
    });
    expect(Linking.openURL).toHaveBeenCalledTimes(2);
  });

  it('turns dictation mode on from step 1', async () => {
    render(<HardwareKeyboardShortcutScreen />);
    fireEvent(screen.getByTestId('hardware-keyboard-dictation-mode'), 'valueChange', true);
    expect(mockSetDictationMode).toHaveBeenCalledWith(true);
    await waitFor(() => expect(mockGetStatus).toHaveBeenCalled());
  });

  it('stresses that the Full Keyboard Access switch must be on', async () => {
    render(<HardwareKeyboardShortcutScreen />);
    expect(screen.getByText(/The shortcut does nothing while it is off/)).toBeTruthy();
    await waitFor(() => expect(mockGetStatus).toHaveBeenCalled());
  });

  it('hides the notifications step once notifications are allowed', async () => {
    render(<HardwareKeyboardShortcutScreen />);
    await waitFor(() => expect(mockGetStatus).toHaveBeenCalled());
    expect(screen.queryByText('Allow notifications')).toBeNull();
    expect(screen.queryByText('Open Settings')).toBeNull();
  });

  it('asks for notification permission when undetermined', async () => {
    mockGetStatus.mockResolvedValue('undetermined');
    mockRequest.mockResolvedValue('granted');
    render(<HardwareKeyboardShortcutScreen />);
    const allow = await screen.findByText('Allow notifications');
    await act(async () => {
      fireEvent.press(allow);
    });
    expect(mockRequest).toHaveBeenCalled();
    expect(screen.queryByText('Allow notifications')).toBeNull();
  });

  it('sends a denied user to Settings instead of re-prompting', async () => {
    mockGetStatus.mockResolvedValue('denied');
    render(<HardwareKeyboardShortcutScreen />);
    const openSettings = await screen.findByText('Open Settings');
    await act(async () => {
      fireEvent.press(openSettings);
    });
    expect(Linking.openSettings).toHaveBeenCalled();
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('checks off the try-it step once text is pasted', async () => {
    render(<HardwareKeyboardShortcutScreen />);
    expect(screen.queryByTestId('hardware-keyboard-try-it-done')).toBeNull();
    fireEvent.changeText(screen.getByTestId('hardware-keyboard-try-it'), 'Hello from the hotkey');
    expect(screen.getByTestId('hardware-keyboard-try-it-done')).toBeTruthy();
    await waitFor(() => expect(mockGetStatus).toHaveBeenCalled());
  });
});
