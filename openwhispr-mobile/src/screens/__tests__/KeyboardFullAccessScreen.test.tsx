import React from 'react';
import { AppState, Linking } from 'react-native';
import { act, fireEvent, render, screen } from '@testing-library/react-native';

const mockRouterBack = jest.fn();
const mockRouterReplace = jest.fn();
const mockCanGoBack = jest.fn(() => true);
const mockPipStart = jest.fn((_video: string) => Promise.resolve(true));
const mockPipStop = jest.fn(() => Promise.resolve(true));
const mockGetItem = jest.fn<string | null, [string]>(() => null);

jest.mock('expo-router', () => ({
  router: {
    back: (...args: unknown[]) => mockRouterBack(...args),
    replace: (...args: unknown[]) => mockRouterReplace(...args),
    canGoBack: () => mockCanGoBack(),
  },
}));
jest.mock('react-native-safe-area-context', () => {
  const { View } = require('react-native');
  return {
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    SafeAreaView: View,
  };
});
jest.mock('react-native-reanimated', () => {
  const { View } = require('react-native');
  const transition = { duration: () => ({}) };

  return {
    __esModule: true,
    default: { View, Text: View },
    FadeInDown: transition,
    FadeOutDown: transition,
    Easing: { out: () => ({}), cubic: {} },
    useSharedValue: () => ({ value: 0 }),
    useAnimatedStyle: () => ({}),
    interpolateColor: () => '#000000',
    withRepeat: jest.fn(),
    withSequence: jest.fn(),
    withDelay: jest.fn(),
    withTiming: jest.fn(),
  };
});
// The nativewind-backed UI primitives can't be parsed by jest's transform, so
// they're stubbed the same way the other screen suites stub them.
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('@/components/ui/Button', () => {
  const mockReact = require('react');
  const mockText = require('react-native').Text;
  return {
    Button: function MockButton(props: {
      children: React.ReactNode;
      onPress: () => void;
      disabled?: boolean;
    }) {
      return mockReact.createElement(
        mockText,
        { onPress: props.disabled ? undefined : props.onPress },
        props.children,
      );
    },
  };
});
jest.mock('@/lib/sentry', () => ({
  Sentry: { addBreadcrumb: jest.fn() },
}));
jest.mock('@/lib/utils', () => ({
  ...jest.requireActual('@/lib/utils'),
  safeHaptics: jest.fn(),
}));
jest.mock('../../../modules/pip-tutorial/src', () => ({
  PipTutorial: {
    start: (video: string) => mockPipStart(video),
    stop: () => mockPipStop(),
  },
}));
jest.mock('../../../modules/app-group-storage/src', () => ({
  APP_GROUP_KEYS: { KEYBOARD_SHOWN_AT_MS: 'keyboard_shown_at_ms' },
  AppGroupStorage: {
    getItem: (key: string) => mockGetItem(key),
  },
}));

import KeyboardFullAccessScreen from '../KeyboardFullAccessScreen';
import { useKeyboardRecoveryStore } from '@/store/useKeyboardRecoveryStore';

// Onboarding's list has five steps and starts with "Enable OpenWhispr". A user
// who reaches recovery has already done that, so this screen must show three.
const RECOVERY_STEPS = ['Tap Keyboards', 'Allow Full Access', 'Tap Allow on the popup'];

let openSettingsSpy: jest.SpyInstance;

async function openSettings(): Promise<void> {
  await act(async () => {
    fireEvent.press(screen.getByText('Open Settings'));
  });
}

// Drives the screen's AppState subscription through a real away-and-back trip.
let appStateListeners: ((state: string) => void)[] = [];
function backgroundThenForeground(): void {
  appStateListeners.forEach((notify) => notify('background'));
  appStateListeners.forEach((notify) => notify('active'));
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  appStateListeners = [];
  jest.spyOn(AppState, 'addEventListener').mockImplementation(((
    _event: string,
    handler: (state: string) => void,
  ) => {
    appStateListeners.push(handler);
    return { remove: jest.fn() };
  }) as never);
  mockCanGoBack.mockReturnValue(true);
  mockGetItem.mockReturnValue(null);
  useKeyboardRecoveryStore.getState().setRecoveryActive(false);
  openSettingsSpy = jest.spyOn(Linking, 'openSettings').mockResolvedValue(undefined);
});

afterEach(() => {
  openSettingsSpy.mockRestore();
  jest.useRealTimers();
});

describe('KeyboardFullAccessScreen', () => {
  // Visible immediately, not only after the user has already left for Settings.
  it('teaches the three recovery steps, not onboarding’s five', () => {
    render(<KeyboardFullAccessScreen />);

    for (const step of RECOVERY_STEPS) {
      expect(screen.getByText(step)).toBeTruthy();
    }
    expect(screen.queryByText('Enable OpenWhispr')).toBeNull();
    expect(screen.queryByText('Come back into the app')).toBeNull();
  });

  it('starts the PiP tutorial before handing off to Settings', async () => {
    render(<KeyboardFullAccessScreen />);
    await openSettings();

    expect(mockPipStart).toHaveBeenCalledWith('keyboard-install');
    expect(openSettingsSpy).toHaveBeenCalledTimes(1);
    expect(mockPipStart.mock.invocationCallOrder[0]).toBeLessThan(
      openSettingsSpy.mock.invocationCallOrder[0],
    );
  });

  // A double-tap on the CTA must not queue a second Settings launch behind the
  // first — the in-flight ref is the only thing preventing that.
  it('does not launch Settings twice while a launch is in flight', async () => {
    let releasePip: (value: boolean) => void = () => {};
    mockPipStart.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        releasePip = resolve;
      }),
    );

    render(<KeyboardFullAccessScreen />);
    const cta = screen.getByText('Open Settings');
    await act(async () => {
      fireEvent.press(cta);
      fireEvent.press(cta);
    });

    expect(mockPipStart).toHaveBeenCalledTimes(1);
    await act(async () => {
      releasePip(true);
    });
    expect(openSettingsSpy).toHaveBeenCalledTimes(1);
  });

  // The keyboard can only write this heartbeat with Full Access granted, so a
  // value newer than the one present at mount is proof the permission is back.
  it('confirms recovery when the keyboard writes a newer heartbeat', () => {
    mockGetItem.mockReturnValue('1000');
    render(<KeyboardFullAccessScreen />);

    mockGetItem.mockReturnValue('2000');
    act(() => {
      jest.advanceTimersByTime(250);
    });

    expect(screen.getByText('Dictation is back on')).toBeTruthy();
  });

  it('ignores a heartbeat that is unchanged or older than the baseline', () => {
    mockGetItem.mockReturnValue('1000');
    render(<KeyboardFullAccessScreen />);

    act(() => {
      jest.advanceTimersByTime(250);
    });
    expect(screen.queryByText('Dictation is back on')).toBeNull();

    mockGetItem.mockReturnValue('900');
    act(() => {
      jest.advanceTimersByTime(250);
    });
    expect(screen.queryByText('Dictation is back on')).toBeNull();
  });

  // `NaN <= baseline` is false, so an unnormalised corrupt value would fall through
  // the poll's guard and tell a still-muted user that dictation is back — then close
  // the only screen that could fix it.
  it('treats a corrupt heartbeat as no heartbeat rather than as success', () => {
    mockGetItem.mockReturnValue('1000');
    render(<KeyboardFullAccessScreen />);

    mockGetItem.mockReturnValue('not-a-number');
    act(() => {
      jest.advanceTimersByTime(250);
    });
    expect(screen.queryByText('Dictation is back on')).toBeNull();
  });

  it('dismisses itself once the confirmation toast has been seen', () => {
    mockGetItem.mockReturnValue('1000');
    render(<KeyboardFullAccessScreen />);

    mockGetItem.mockReturnValue('2000');
    act(() => {
      jest.advanceTimersByTime(250);
    });
    expect(mockRouterBack).not.toHaveBeenCalled();

    act(() => {
      jest.advanceTimersByTime(2200);
    });
    expect(mockRouterBack).toHaveBeenCalledTimes(1);
  });

  // v2 removed the confirm phase: returning from Settings leaves the instruct
  // screen in place, with the heartbeat poll as the only automatic exit and
  // Close as the manual one.
  it('keeps the instructions up after returning from Settings', async () => {
    render(<KeyboardFullAccessScreen />);
    await openSettings();
    await act(async () => {
      backgroundThenForeground();
    });

    expect(screen.getByText('Tap Keyboards')).toBeTruthy();
    expect(screen.getByText('Open Settings')).toBeTruthy();
    expect(screen.queryByText('Done')).toBeNull();
    expect(screen.queryByText('Open Settings again')).toBeNull();
    expect(screen.queryByLabelText(/press and hold the globe key/i)).toBeNull();
  });

  // A phone call or a notification is not a Settings trip: coming back from one
  // must leave the instructions up, not skip to "did it work?".
  it('stays on the instructions when the user leaves without opening Settings', () => {
    render(<KeyboardFullAccessScreen />);
    act(() => {
      backgroundThenForeground();
    });

    expect(screen.getByText('Tap Keyboards')).toBeTruthy();
    expect(screen.getByText('Open Settings')).toBeTruthy();
    expect(screen.queryByText('Done')).toBeNull();
  });

  // A deep link straight from the keyboard leaves no back entry to return to.
  it('replaces with Home when there is nothing to go back to', () => {
    mockCanGoBack.mockReturnValue(false);
    render(<KeyboardFullAccessScreen />);

    fireEvent.press(screen.getByText('Close'));

    expect(mockRouterBack).not.toHaveBeenCalled();
    expect(mockRouterReplace).toHaveBeenCalledWith('/(tabs)/(record)');
  });

  // Lifetime-scoped: the resume guard reads this flag, and a stranded `true`
  // would pin the app to whatever screen happens to be showing.
  it('flags recovery for exactly as long as it is mounted', () => {
    const view = render(<KeyboardFullAccessScreen />);
    expect(useKeyboardRecoveryStore.getState().isRecoveryActive).toBe(true);

    view.unmount();
    expect(useKeyboardRecoveryStore.getState().isRecoveryActive).toBe(false);
  });
});
