import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react-native';
import { StyleSheet, useColorScheme } from 'react-native';

const mockPrepare = jest.fn(async () => true);
jest.mock('../../../modules/android-dictation/src/themeFade', () => ({
  prepareThemeFade: () => mockPrepare(),
  fadeTheme: jest.fn(),
}));
jest.mock('react-native/Libraries/Utilities/useColorScheme', () => ({
  __esModule: true,
  default: jest.fn(() => 'light'),
}));
jest.mock('@/android/navigationBar', () => ({
  useNavigationBar: () => ({ buttons: true, inset: 0 }),
  useNavigationBarCanvas: () => undefined,
}));
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), canGoBack: () => true },
  useLocalSearchParams: () => ({ kind: 'speech' }),
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en', dir: () => 'ltr' } }),
}));
jest.mock('@/android/strings', () => ({
  __esModule: true,
  default: { addResourceBundle: jest.fn(), t: (key: string) => key },
}));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({
  SystemIcon: ({ color }: { color: string }) => {
    const { View: Glyph } = require('react-native');
    return <Glyph testID="glyph" accessibilityHint={color} />;
  },
}));
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: require('react-native').View,
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('@react-navigation/native', () => ({ useIsFocused: () => true }));
// The ring's circles report their stroke and count their mounts, so a switch that remounted the
// ring (and restarted its animation) would show.
let mockCircleMounts = 0;
jest.mock('react-native-svg', () => {
  const ReactLib = require('react');
  const { View } = require('react-native');
  const Shape = (testID: string) =>
    ReactLib.forwardRef(function SvgShape(
      { stroke, fill }: { stroke?: string; fill?: string },
      ref: unknown,
    ) {
      ReactLib.useEffect(() => {
        if (testID === 'circle') mockCircleMounts += 1;
      }, []);
      return <View ref={ref} testID={testID} accessibilityHint={stroke ?? fill} />;
    });
  return {
    __esModule: true,
    default: View,
    Circle: Shape('circle'),
    Path: Shape('path'),
    Rect: Shape('rect'),
  };
});
jest.mock('expo-haptics', () => ({
  performAndroidHapticsAsync: jest.fn(async () => undefined),
  AndroidHaptics: { Confirm: 'confirm', Reject: 'reject', Clock_Tick: 'clock-tick' },
}));
jest.mock('../models', () => ({
  ANDROID_MODELS: {
    'parakeet-v3': { title: 'Parakeet v3', bytes: 670478772 },
    'moonshine-small': { title: 'Moonshine Small', bytes: 142300974 },
    'moonshine-tiny': { title: 'Moonshine Tiny', bytes: 45233659 },
  },
  modelReady: async () => false,
  modelSupported: () => true,
  removeAndroidModel: jest.fn(async () => undefined),
  downloadAndroidModel: jest.fn(async () => undefined),
  cancelAndroidDownload: jest.fn(async () => undefined),
  useModelDownloads: require('zustand').create(() => ({ progress: {} })),
}));
jest.mock('@/store/useAuthStore', () => ({ useAuthStore: () => null }));
jest.mock('@/android/store/useAuthStore', () => jest.requireMock('@/store/useAuthStore'));
jest.mock('../speechSelection', () => ({ canTranscribeMeetings: () => true }));
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: require('zustand').create(() => ({ config: {}, error: null })),
}));
jest.mock('@/android/store/useConfigStore', () => jest.requireMock('@/store/useConfigStore'));

import { ThemeProvider } from '../ThemeProvider';
import { darkTheme, lightTheme } from '../theme';
import { useModelDownloads } from '../models';
import ModelScreen from '../settings/ModelScreen';
import { ModelRow } from '../settings/ModelRow';
import { MODEL_ROWS } from '../settings/modelCatalog';
import { KeyCheckMark } from '../settings/KeyCheckMark';

const mockScheme = useColorScheme as jest.MockedFunction<typeof useColorScheme>;
const flat = (style: unknown) => StyleSheet.flatten(style as never) as Record<string, unknown>;
const hints = (testID: string) =>
  screen.getAllByTestId(testID).map((node) => node.props.accessibilityHint as string);

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
  mockScheme.mockReturnValue('light');
  mockCircleMounts = 0;
  useModelDownloads.setState({ progress: {} });
});

describe.each([
  ['light', lightTheme],
  ['dark', darkTheme],
] as const)('models in %s', (scheme, tokens) => {
  it('draws the model list, its ring and the page from the scheme', async () => {
    useModelDownloads.setState({ progress: { 'parakeet-v3': 0.4 } });
    inTheme(scheme, () => <ModelScreen />);
    await waitFor(() => expect(screen.getByLabelText('cancelDownload')).toBeTruthy());
    // The ring's track and its fill.
    expect(hints('circle')).toEqual([tokens.track, tokens.accent]);
    expect(hints('rect')).toEqual([tokens.accent]);
    // The models not on the phone offer a download arrow in the accent.
    expect(hints('glyph')).toContain(tokens.accent);
    expect(flat(screen.getByText('Moonshine Small').props.style).color).toBe(tokens.ink);
  });

  it('draws a model row offering Download in the accent', () => {
    inTheme(scheme, () => (
      <ModelRow
        row={MODEL_ROWS[0]}
        ready={false}
        inUse={false}
        progress={undefined}
        dimmed={false}
        reduceMotion
      />
    ));
    expect(flat(screen.getByText('download').props.style).color).toBe(tokens.accent);
    expect(flat(screen.getByText('Parakeet v3').props.style).color).toBe(tokens.ink);
  });

  it('marks a refused key in the scheme’s error red', () => {
    inTheme(scheme, () => <KeyCheckMark state="failed" animate={false} />);
    const red = scheme === 'dark' ? darkTheme.error : '#E5372B';
    expect(hints('circle')).toEqual([red]);
    expect(hints('path').every((hint) => hint === red)).toBe(true);
  });

  it('marks an accepted key in the scheme’s green', () => {
    inTheme(scheme, () => <KeyCheckMark state="connected" animate={false} />);
    expect(hints('path')).toEqual([tokens.connected]);
  });
});

it('repaints a downloading model in place on a live switch', async () => {
  useModelDownloads.setState({ progress: { 'parakeet-v3': 0.4 } });
  const tree = () => <ModelScreen />;
  const { rerender } = inTheme('light', tree);
  await waitFor(() => expect(screen.getByLabelText('cancelDownload')).toBeTruthy());
  const ring = screen.getByLabelText('cancelDownload');
  const row = screen.getByText('Moonshine Small');
  const mounts = mockCircleMounts;
  expect(hints('circle')).toEqual([lightTheme.track, lightTheme.accent]);

  await switchTo('dark', rerender, tree);
  expect(screen.getByLabelText('cancelDownload')).toBe(ring);
  expect(screen.getByText('Moonshine Small')).toBe(row);
  expect(mockCircleMounts).toBe(mounts);
  expect(useModelDownloads.getState().progress).toEqual({ 'parakeet-v3': 0.4 });
  expect(hints('circle')).toEqual([darkTheme.track, darkTheme.accent]);
  expect(flat(row.props.style).color).toBe(darkTheme.ink);

  await switchTo('light', rerender, tree);
  expect(screen.getByLabelText('cancelDownload')).toBe(ring);
  expect(mockCircleMounts).toBe(mounts);
  expect(useModelDownloads.getState().progress).toEqual({ 'parakeet-v3': 0.4 });
  expect(hints('circle')).toEqual([lightTheme.track, lightTheme.accent]);
});
