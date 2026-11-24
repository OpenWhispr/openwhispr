import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { StyleSheet, useColorScheme } from 'react-native';

/**
 * Dark theme, segment 7 (Account flows): the blue sign-in screens look the same in both schemes
 * (design §3.7), own the button bar with the blue's foot, and a light/dark switch on a sign-in
 * form keeps the typed text, the field and its focus.
 */
const mockPrepare = jest.fn(async () => true);
jest.mock('../../../modules/android-dictation/src/themeFade', () => ({
  prepareThemeFade: () => mockPrepare(),
  fadeTheme: jest.fn(),
}));
jest.mock('react-native/Libraries/Utilities/useColorScheme', () => ({
  __esModule: true,
  default: jest.fn(() => 'light'),
}));
const mockNavBar = jest.fn();
jest.mock('../navigationBar', () => ({
  useNavigationBarCanvas: (colour: string) => mockNavBar(colour),
}));
const mockStatusBar = jest.fn();
jest.mock('expo-status-bar', () => ({
  StatusBar: ({ style }: { style: string }) => {
    mockStatusBar(style);
    return null;
  },
}));
jest.mock('expo-linear-gradient', () => ({
  LinearGradient: ({ colors }: { colors: string[] }) => {
    const { View } = require('react-native');
    return <View testID="gradient" accessibilityHint={colors.join(' ')} />;
  },
}));
const store = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
  },
});
const mockAuth = {
  user: null,
  isLoading: false,
  loadingProvider: null,
  error: null,
  signIn: jest.fn(),
  signUp: jest.fn(),
  signOut: jest.fn(),
  signInWithGoogle: jest.fn(),
  signInWithMicrosoft: jest.fn(),
  continueAsGuest: jest.fn(),
  clearError: jest.fn(),
};
jest.mock('@/store/useAuthStore', () => {
  const useMockAuthStore = (selector?: (state: typeof mockAuth) => unknown) =>
    selector ? selector(mockAuth) : mockAuth;
  useMockAuthStore.getState = () => mockAuth;
  useMockAuthStore.setState = jest.fn();
  return { useAuthStore: useMockAuthStore };
});
jest.mock('@/lib/authClient', () => ({ checkUserExists: jest.fn() }));
jest.mock('@/lib/authClient.android', () => ({
  requestPasswordResetEmail: jest.fn(),
  resetPasswordWithToken: jest.fn(),
  requestVerificationEmail: jest.fn(),
}));
jest.mock('@/lib/sessionFetch.android', () => ({ sessionFetch: jest.fn() }));
jest.mock('@/lib/apiClient', () => ({
  ApiError: class extends Error {},
  BASE_URL: 'https://api.test',
  getClientVersionHeader: () => ({}),
  api: { get: jest.fn(), post: jest.fn() },
}));
jest.mock('@/android/settings/kit', () => ({ showToast: jest.fn() }));
jest.mock('../settings/kit', () => ({ showToast: jest.fn() }));
jest.mock('@/lib/utils', () => ({ safeHaptics: jest.fn() }));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({
  SystemIcon: ({ color }: { color: string }) => {
    const { View } = require('react-native');
    return <View testID="glyph" accessibilityHint={color} />;
  },
}));
jest.mock('@/components/ui/OpenWhisprMark', () => ({ OpenWhisprMark: () => null }));
jest.mock('react-native-svg', () => {
  const Stub = () => null;
  return {
    __esModule: true,
    default: Stub,
    Circle: Stub,
    Defs: Stub,
    LinearGradient: Stub,
    Path: Stub,
    RadialGradient: Stub,
    Rect: Stub,
    Stop: Stub,
  };
});
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('../../../modules/android-dictation/src', () => ({
  AndroidDictation: { getLocale: () => 'en-US', openEmailApp: () => true },
}));

import AuthScreen from '@/screens/AuthScreen.android';
import { ThemeProvider } from '../ThemeProvider';
import { AuthField, WhiteButton } from '../auth/look';
import { ForgotPassword } from '../auth/ForgotPassword';
import { lightTheme } from '../theme';

const mockScheme = useColorScheme as jest.MockedFunction<typeof useColorScheme>;
const flat = (style: unknown) => StyleSheet.flatten(style as never) as Record<string, unknown>;
const gradients = () =>
  screen.getAllByTestId('gradient').map((node) => node.props.accessibilityHint);

type Node = ReturnType<typeof screen.getByText>;
/** The outline round a field: the nearest host view above it with a border colour. */
function outline(node: Node) {
  for (let n: Node | null = node.parent; n; n = n.parent)
    if (typeof n.type === 'string' && flat(n.props.style)?.borderColor)
      return flat(n.props.style).borderColor;
  return undefined;
}

function inTheme(scheme: 'light' | 'dark', node: () => React.ReactElement) {
  mockScheme.mockReturnValue(scheme);
  return render(<ThemeProvider>{node()}</ThemeProvider>);
}

async function switchTo(
  scheme: 'light' | 'dark',
  rerender: (node: React.ReactElement) => void,
  node: () => React.ReactElement,
) {
  mockScheme.mockReturnValue(scheme);
  await act(async () => {
    rerender(<ThemeProvider>{node()}</ThemeProvider>);
  });
}

beforeEach(() => {
  store.clear();
  jest.clearAllMocks();
  mockScheme.mockReturnValue('light');
});

describe.each(['light', 'dark'] as const)('the sign-in screen in %s', (scheme) => {
  it('keeps the blue, the white glass and its ink label (§3.7)', () => {
    inTheme(scheme, () => <AuthScreen onClose={jest.fn()} />);
    expect(gradients()).toContain(
      [lightTheme.signInTop, lightTheme.signInMid, lightTheme.signInFoot].join(' '),
    );
    expect(gradients()).toContain([lightTheme.surface, lightTheme.whiteGlassFoot].join(' '));
    expect(flat(screen.getByText('Continue').props.style).color).toBe(lightTheme.onGlass);
  });

  it('gives the button bar the blue foot and the status bar light icons', () => {
    inTheme(scheme, () => <AuthScreen onClose={jest.fn()} />);
    expect(mockNavBar).toHaveBeenLastCalledWith(lightTheme.signInFoot);
    expect(mockStatusBar).toHaveBeenLastCalledWith('light');
  });

  it('draws a white button with an ink label, never the dark ink', () => {
    inTheme(scheme, () => <WhiteButton label="Sign in" onPress={jest.fn()} />);
    expect(flat(screen.getByText('Sign in').props.style).color).toBe(lightTheme.ink);
    expect(gradients()).toEqual([[lightTheme.surface, lightTheme.whiteGlassFoot].join(' ')]);
  });

  it('outlines a field in error in the blue screens’ own red', () => {
    inTheme(scheme, () => <AuthField accessibilityLabel="Email" value="" error />);
    const field = screen.getByLabelText('Email');
    expect(outline(field)).toBe(lightTheme.onBlueErrorLine);
    expect(field.props.cursorColor).toBe(lightTheme.onGlass);
  });
});

describe('a light/dark switch on a sign-in form (§3b)', () => {
  it('keeps the typed email, the same field and its focus on the sign-in screen', async () => {
    const tree = () => <AuthScreen onClose={jest.fn()} />;
    const { rerender } = inTheme('light', tree);
    const field = screen.getByLabelText('Email address');
    fireEvent(field, 'focus');
    fireEvent.changeText(field, 'alex@example.com');

    await switchTo('dark', rerender, tree);
    expect(mockPrepare).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('Email address')).toBe(field);
    expect(field.props.value).toBe('alex@example.com');
    // Still focused: the focus outline stays, and the colours on the blue don't change.
    expect(outline(field)).toBe('rgba(255,255,255,0.55)');
    expect(flat(field.props.style).color).toBe(lightTheme.onGlass);
    expect(mockNavBar).toHaveBeenLastCalledWith(lightTheme.signInFoot);

    await switchTo('light', rerender, tree);
    expect(screen.getByLabelText('Email address')).toBe(field);
    expect(field.props.value).toBe('alex@example.com');
  });

  it('keeps the email typed into Forgot password', async () => {
    const tree = () => (
      <ForgotPassword initialEmail="" onSent={jest.fn()} onBackToSignIn={jest.fn()} />
    );
    const { rerender } = inTheme('dark', tree);
    const field = screen.getByLabelText('Email address');
    fireEvent.changeText(field, 'sam@example.com');
    await switchTo('light', rerender, tree);
    expect(screen.getByLabelText('Email address')).toBe(field);
    expect(field.props.value).toBe('sam@example.com');
    await switchTo('dark', rerender, tree);
    expect(screen.getByLabelText('Email address')).toBe(field);
    expect(field.props.value).toBe('sam@example.com');
  });
});
