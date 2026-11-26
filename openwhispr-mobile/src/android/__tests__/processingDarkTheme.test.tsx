import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
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
const mockNavBar = jest.fn();
jest.mock('@/android/navigationBar', () => ({
  useNavigationBar: () => ({ buttons: true, inset: 0 }),
  useNavigationBarCanvas: (colour: string) => mockNavBar(colour),
}));
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), canGoBack: () => true },
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
  SystemIcon: ({ color, mdName }: { color: string; mdName: string }) => {
    const { View: Glyph } = require('react-native');
    return <Glyph testID={`glyph-${mdName}`} accessibilityHint={color} />;
  },
}));
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: require('react-native').View,
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('@react-navigation/native', () => ({
  useScrollToTop: () => undefined,
  useIsFocused: () => true,
}));
jest.mock('react-native-svg', () => {
  const { View } = require('react-native');
  return {
    __esModule: true,
    default: View,
    Circle: View,
    Path: View,
    Rect: View,
    SvgXml: ({ xml }: { xml: string }) => <View testID="mark" accessibilityHint={xml} />,
  };
});
jest.mock('expo-haptics', () => ({
  performAndroidHapticsAsync: jest.fn(async () => undefined),
  AndroidHaptics: { Confirm: 'confirm', Reject: 'reject', Clock_Tick: 'clock-tick' },
}));
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: (selector: (state: { user: object | null }) => unknown) =>
    selector({ user: { id: 'a', isAnonymous: false } }),
}));
jest.mock('@/android/store/useAuthStore', () => jest.requireMock('@/store/useAuthStore'));
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: require('zustand').create(() => ({ config: {}, error: null })),
}));
jest.mock('@/android/store/useConfigStore', () => jest.requireMock('@/store/useConfigStore'));
jest.mock('@/store/useProcessingModeStore', () => ({
  useProcessingModeStore: require('zustand').create(() => ({ activeMode: 'cloud' })),
}));
jest.mock('@/android/shared/store/useProcessingModeStore', () =>
  jest.requireMock('@/store/useProcessingModeStore'),
);
jest.mock('../models', () => ({
  ANDROID_MODELS: {
    'parakeet-v3': { title: 'Parakeet v3', bytes: 670478772 },
    'qwen-balanced': { title: 'Qwen3 1.7B', bytes: 1100000000 },
  },
  modelReady: async () => true,
  useModelDownloads: () => ({}),
}));
// The sheets are their own screens; this file checks the page and the shared pieces.
jest.mock('../processingFable/TaskSheet', () => ({ TaskSheet: () => null }));
jest.mock('../processingFable/AddKeySheet', () => ({ AddKeySheet: () => null }));
jest.mock('../processingFable/KeyDetailSheet', () => ({ KeyDetailSheet: () => null }));
jest.mock('../processingFable/DeviceSheet', () => ({ DeviceSheet: () => null }));
jest.mock('../processingFable/places', () => {
  const { create } = require('zustand');
  const placeOf: Record<string, { place: string; source?: string }> = {
    dictation: { place: 'cloud' },
    upload: { place: 'cloud' },
    cleanup: { place: 'key', source: 'openai' },
    notes: { place: 'device' },
    agent: { place: 'cloud' },
    meeting: { place: 'cloud' },
  };
  return {
    TASK_TITLE: {
      dictation: 'taskDictation',
      upload: 'taskUpload',
      cleanup: 'taskCleanup',
      notes: 'taskNotes',
      agent: 'taskAgent',
      meeting: 'taskMeeting',
    },
    placementOf: (_c: unknown, task: string) => placeOf[task],
    usePhoneQueue: create(() => ({ jobs: [], doneBytes: 0, totalBytes: 0 })),
    useSavedSources: () => [{ source: 'openai', tail: 'abcd' }],
    sourceName: (source: string) => (source === 'openai' ? 'OpenAI' : source),
    cancelPhoneDownloads: jest.fn(),
    everythingOnCloud: jest.fn(),
    everythingOnDevice: jest.fn(),
    missingForEverything: jest.fn(),
  };
});

// The app's localStorage is SQLite-backed; a plain in-memory one stands in here.
const memory = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => void memory.set(key, value),
    removeItem: (key: string) => void memory.delete(key),
  },
});

/* eslint-disable @typescript-eslint/no-require-imports */
const { ThemeProvider, themeFor } =
  require('../ThemeProvider') as typeof import('../ThemeProvider');
const { darkTheme, lightTheme } = require('../theme') as typeof import('../theme');
const ProcessingScreen = (
  require('../processingFable/ProcessingScreen') as typeof import('../processingFable/ProcessingScreen')
).default;
const { Field, RadioRow, Reason, TaskChip } =
  require('../processingFable/ui') as typeof import('../processingFable/ui');
/* eslint-enable @typescript-eslint/no-require-imports */

type ReactTestInstance = ReturnType<typeof screen.getByText>;
const mockScheme = useColorScheme as jest.MockedFunction<typeof useColorScheme>;
const flat = (style: unknown) => StyleSheet.flatten(style as never) as Record<string, unknown>;
const textColour = (text: string) => flat(screen.getByText(text).props.style).color;
/** The nearest host view above [node] with a background. */
function fillOf(node: ReactTestInstance) {
  for (let n: ReactTestInstance | null = node; n; n = n.parent)
    if (typeof n.type === 'string' && flat(n.props.style)?.backgroundColor)
      return flat(n.props.style).backgroundColor;
  return undefined;
}

/** The nearest host view above [node] that sets [key]. */
function styleAbove(node: ReactTestInstance, key: string) {
  for (let n: ReactTestInstance | null = node.parent; n; n = n.parent)
    if (typeof n.type === 'string' && flat(n.props.style)?.[key]) return flat(n.props.style)[key];
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
  mockScheme.mockReturnValue('light');
  mockPrepare.mockClear();
  mockNavBar.mockClear();
});

describe.each([
  ['light', lightTheme],
  ['dark', darkTheme],
] as const)('Processing in %s', (scheme, tokens) => {
  it('paints the page, its cards and the key line from the palette', () => {
    inTheme(scheme, () => <ProcessingScreen />);
    expect(mockNavBar).toHaveBeenLastCalledWith(tokens.canvas);
    expect(textColour('cloud')).toBe(tokens.ink);
    expect(textColour('cloudSignedIn')).toBe(tokens.secondary);
    expect(fillOf(screen.getByText('cloudSignedIn'))).toBe(tokens.surface);
    expect(textColour('tapTaskHint')).toBe(tokens.tertiary);
    // The key that runs a task gets the connected tick.
    expect(screen.getByTestId('glyph-Check').props.accessibilityHint).toBe(tokens.connected);
    expect(screen.getAllByTestId('glyph-ChevronRight')[0].props.accessibilityHint).toBe(
      tokens.tertiary,
    );
  });

  it('draws task chips raised, a picked row tinted and a failed reason in red', () => {
    inTheme(scheme, () => (
      <>
        <TaskChip label="Chip" icon="Mic" onPress={() => undefined} />
        <RadioRow title="Picked" selected onPress={() => undefined} />
        <Reason text="Nope" failed />
      </>
    ));
    const chip = screen.getByRole('button', { name: 'Chip' });
    expect(flat(chip.props.style)).toMatchObject(flat(themeFor(scheme).raised));
    expect(textColour('Chip')).toBe(tokens.ink);
    expect(screen.getByTestId('glyph-Mic').props.accessibilityHint).toBe(tokens.secondary);
    expect(flat(screen.getByRole('radio').props.style).backgroundColor).toBe(
      scheme === 'dark' ? 'rgba(110,155,255,0.14)' : 'rgba(21,85,212,0.08)',
    );
    expect(textColour('Nope')).toBe(tokens.error);
  });

  it('gives a field the surface, the field hairline and a tertiary placeholder', () => {
    inTheme(scheme, () => (
      <Field label="Key" value="" onChangeText={() => undefined} placeholder="Paste" />
    ));
    const input = screen.getByLabelText('Key');
    expect(input.props.placeholderTextColor).toBe(tokens.tertiary);
    expect(fillOf(input)).toBe(tokens.surface);
    expect(styleAbove(input, 'borderColor')).toBe(tokens.fieldHairline);
    expect(textColour('Key')).toBe(tokens.secondary);
  });
});

describe('live switch (design §3b)', () => {
  it('repaints a field in place, keeping its text', async () => {
    function Typed() {
      const [value, setValue] = React.useState('');
      return <Field label="Key" value={value} onChangeText={setValue} />;
    }
    const tree = () => <Typed />;
    const { rerender } = inTheme('light', tree);
    fireEvent.changeText(screen.getByLabelText('Key'), 'sk-123');
    const input = screen.getByLabelText('Key');
    expect(fillOf(input)).toBe(lightTheme.surface);

    await switchTo('dark', rerender, tree);
    expect(screen.getByLabelText('Key')).toBe(input);
    expect(screen.getByLabelText('Key').props.value).toBe('sk-123');
    expect(fillOf(screen.getByLabelText('Key'))).toBe(darkTheme.surface);
  });

  it('repaints the Processing page in place', async () => {
    const tree = () => <ProcessingScreen />;
    const { rerender } = inTheme('light', tree);
    const title = screen.getByText('whereProcessed');
    expect(textColour('cloud')).toBe(lightTheme.ink);

    await switchTo('dark', rerender, tree);
    expect(screen.getByText('whereProcessed')).toBe(title);
    expect(textColour('cloud')).toBe(darkTheme.ink);
    expect(mockNavBar).toHaveBeenLastCalledWith(darkTheme.canvas);
  });
});
