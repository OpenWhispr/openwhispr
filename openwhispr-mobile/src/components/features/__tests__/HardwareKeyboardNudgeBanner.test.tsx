import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';

const mockRouterPush = jest.fn();
const mockUpdateConfig = jest.fn(async () => undefined);
let mockConnected = true;
let mockConfig: Record<string, unknown> | null = {};

jest.mock('expo-router', () => ({
  router: { push: (...args: unknown[]) => mockRouterPush(...args) },
}));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('@/lib/utils', () => ({
  ...jest.requireActual('@/lib/utils'),
  safeHaptics: jest.fn(),
}));
jest.mock('@/hooks/useHardwareKeyboardConnected', () => ({
  useHardwareKeyboardConnected: () => mockConnected,
}));
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: (selector: (state: unknown) => unknown) =>
    selector({ config: mockConfig, updateConfig: mockUpdateConfig }),
}));

import { HardwareKeyboardNudgeBanner } from '../HardwareKeyboardNudgeBanner';

beforeEach(() => {
  jest.clearAllMocks();
  mockConnected = true;
  mockConfig = {};
});

describe('HardwareKeyboardNudgeBanner', () => {
  it('shows when a hardware keyboard is connected and it was never dismissed', () => {
    render(<HardwareKeyboardNudgeBanner />);
    expect(screen.getByTestId('hardware-keyboard-nudge')).toBeTruthy();
  });

  it('stays hidden without a hardware keyboard', () => {
    mockConnected = false;
    render(<HardwareKeyboardNudgeBanner />);
    expect(screen.queryByTestId('hardware-keyboard-nudge')).toBeNull();
  });

  it('stays hidden once dismissed', () => {
    mockConfig = { hardwareKeyboardNudgeDismissedAt: '2026-09-25T00:00:00.000Z' };
    render(<HardwareKeyboardNudgeBanner />);
    expect(screen.queryByTestId('hardware-keyboard-nudge')).toBeNull();
  });

  it('stays hidden until the config has loaded', () => {
    mockConfig = null;
    render(<HardwareKeyboardNudgeBanner />);
    expect(screen.queryByTestId('hardware-keyboard-nudge')).toBeNull();
  });

  it('opens the guide and marks the nudge seen', () => {
    render(<HardwareKeyboardNudgeBanner />);
    fireEvent.press(screen.getByTestId('hardware-keyboard-nudge-cta'));
    expect(mockRouterPush).toHaveBeenCalledWith('/(account)/hardware-keyboard');
    expect(mockUpdateConfig).toHaveBeenCalledWith({
      hardwareKeyboardNudgeDismissedAt: expect.any(String),
    });
  });

  it('dismisses without navigating', () => {
    render(<HardwareKeyboardNudgeBanner />);
    fireEvent.press(screen.getByTestId('hardware-keyboard-nudge-dismiss'));
    expect(mockRouterPush).not.toHaveBeenCalled();
    expect(mockUpdateConfig).toHaveBeenCalledWith({
      hardwareKeyboardNudgeDismissedAt: expect.any(String),
    });
  });
});
