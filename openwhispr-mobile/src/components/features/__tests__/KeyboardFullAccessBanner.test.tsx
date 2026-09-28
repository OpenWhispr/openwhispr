import React from 'react';
import { AppState } from 'react-native';
import { act, fireEvent, render, screen } from '@testing-library/react-native';

const mockRouterPush = jest.fn();
// Rest params (not zero-arg) so the mock factory below can forward `...args`
// without tripping TS2556.
const mockEvaluate = jest.fn((..._args: unknown[]) => ({}) as never);
const mockShouldShow = jest.fn((..._args: unknown[]) => true);
const mockDismiss = jest.fn();

jest.mock('expo-router', () => ({
  router: { push: (...args: unknown[]) => mockRouterPush(...args) },
}));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('@/lib/utils', () => ({
  ...jest.requireActual('@/lib/utils'),
  safeHaptics: jest.fn(),
}));
jest.mock('@/lib/keyboardFullAccessProbe', () => ({
  evaluate: (...args: unknown[]) => mockEvaluate(...args),
  shouldShowFullAccessBanner: (...args: unknown[]) => mockShouldShow(...args),
  dismissFullAccessBanner: (...args: unknown[]) => mockDismiss(...args),
}));

import { KeyboardFullAccessBanner } from '../KeyboardFullAccessBanner';

// Drives the banner's AppState subscription (same helper as the screen suite).
let appStateListeners: ((state: string) => void)[] = [];

beforeEach(() => {
  jest.clearAllMocks();
  mockShouldShow.mockReturnValue(true);
  appStateListeners = [];
  jest.spyOn(AppState, 'addEventListener').mockImplementation(((
    _event: string,
    handler: (state: string) => void,
  ) => {
    appStateListeners.push(handler);
    return { remove: jest.fn() };
  }) as never);
});

describe('KeyboardFullAccessBanner', () => {
  it('asks the question when the probe rule says show', () => {
    render(<KeyboardFullAccessBanner />);
    expect(screen.getByText('Keyboard dictation not working?')).toBeTruthy();
  });

  it('renders nothing when the probe rule says hide', () => {
    mockShouldShow.mockReturnValue(false);
    render(<KeyboardFullAccessBanner />);
    expect(screen.queryByText('Keyboard dictation not working?')).toBeNull();
  });

  it('opens the recovery screen on tap', () => {
    render(<KeyboardFullAccessBanner />);
    fireEvent.press(screen.getByText('Keyboard dictation not working?'));
    expect(mockRouterPush).toHaveBeenCalledWith('/keyboard-full-access');
  });

  it('persists dismissal and hides itself', () => {
    render(<KeyboardFullAccessBanner />);
    fireEvent.press(screen.getByTestId('keyboard-full-access-banner-dismiss'));
    expect(mockDismiss).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Keyboard dictation not working?')).toBeNull();
  });

  // Spec §2: re-evaluated on app foreground, so it clears itself once the
  // keyboard proves it can write again.
  it('re-evaluates on foreground and clears once the keyboard is healthy', () => {
    render(<KeyboardFullAccessBanner />);
    expect(screen.getByText('Keyboard dictation not working?')).toBeTruthy();

    mockShouldShow.mockReturnValue(false);
    act(() => {
      appStateListeners.forEach((notify) => notify('active'));
    });
    expect(screen.queryByText('Keyboard dictation not working?')).toBeNull();
  });
});
