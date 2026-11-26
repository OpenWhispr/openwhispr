import React, { useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Pressable, StyleSheet, Text, useColorScheme, View } from 'react-native';

const mockPrepare = jest.fn(async () => true);
jest.mock('../../../modules/android-dictation/src/themeFade', () => ({
  prepareThemeFade: () => mockPrepare(),
  fadeTheme: jest.fn(),
}));
jest.mock('react-native/Libraries/Utilities/useColorScheme', () => ({
  __esModule: true,
  default: jest.fn(() => 'light'),
}));
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({
  SystemIcon: ({ color }: { color: string }) => {
    const { View: Glyph } = require('react-native');
    return <Glyph testID="glyph" accessibilityHint={color} />;
  },
}));
jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
jest.mock('expo-video', () => ({ useVideoPlayer: jest.fn(), VideoView: () => null }));
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: (pick: (s: object) => unknown) => pick({ user: null, isGuest: true }),
}));
jest.mock('@/android/store/useAuthStore', () => jest.requireMock('@/store/useAuthStore'));
jest.mock('../home/strings', () => ({ useHomeT: () => (key: string) => key }));
jest.mock('react-native-gesture-handler', () => ({
  GestureDetector: ({ children }: { children: React.ReactNode }) => children,
  GestureHandlerRootView: require('react-native').View,
}));
jest.mock('@/hooks/useSheetDragToDismiss', () => ({
  useSheetDragToDismiss: () => ({ dragGesture: {}, sheetStyle: {} }),
}));
jest.mock('@/android/hooks/useSheetDragToDismiss', () =>
  jest.requireMock('@/hooks/useSheetDragToDismiss'),
);
jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  default: { View: require('react-native').View },
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
  SafeAreaView: require('react-native').View,
}));

import { ThemeProvider } from '../ThemeProvider';
import { darkTheme, lightTheme } from '../theme';
import { IconTile, PillButton, SectionHeader, TileButton, useHome } from '../home/kit';
import { HistoryCard, Stats } from '../home/Sections';
import { OlderRecordingsRow } from '../home/OlderRecordings';
import type { Transcript } from '@/types';

const mockScheme = useColorScheme as jest.MockedFunction<typeof useColorScheme>;
const flat = (style: unknown) => StyleSheet.flatten(style as never) as Record<string, unknown>;

const items = [
  { id: 'a', text: 'Ship the dark theme', status: 'completed', createdAt: Date.now() },
  {
    id: 'b',
    text: '',
    errorMessage: 'Unreadable audio',
    status: 'failed',
    audioUrl: 'file://a.wav',
    createdAt: Date.now() - 60_000,
  },
] as unknown as Transcript[];

/** A card of Home pieces, the way Home stacks them. */
function HomePieces() {
  const { c, card } = useHome();
  return (
    <View testID="page" style={{ backgroundColor: c.canvas }}>
      <SectionHeader title="history" action={{ label: 'hide', onPress: () => undefined }} />
      <View testID="card" style={card}>
        <IconTile icon="Mic" />
        <TileButton icon="Copy" label="copy" onPress={() => undefined} />
      </View>
      <PillButton label="dictate" onPress={() => undefined} />
      <PillButton primary label="allow" onPress={() => undefined} />
      <Stats stats={{ words: 1234, wordsPerMinute: 120, streakDays: 3 }} />
      <HistoryCard
        items={items}
        busy={false}
        onCopy={() => undefined}
        onRetry={() => undefined}
        onSeeAll={() => undefined}
      />
      <OlderRecordingsRow count={2} onPress={() => undefined} />
    </View>
  );
}

function renderIn(scheme: 'light' | 'dark') {
  mockScheme.mockReturnValue(scheme);
  return render(
    <ThemeProvider>
      <HomePieces />
    </ThemeProvider>,
  );
}

beforeEach(() => {
  mockScheme.mockReturnValue('light');
  mockPrepare.mockClear();
});

describe.each([
  ['light', lightTheme],
  ['dark', darkTheme],
] as const)('Home in %s', (scheme, tokens) => {
  it('draws the page, cards, tiles and text from that palette', () => {
    renderIn(scheme);
    expect(flat(screen.getByTestId('page').props.style).backgroundColor).toBe(tokens.canvas);
    const card = flat(screen.getByTestId('card').props.style);
    expect(card.backgroundColor).toBe(tokens.surface);
    expect(card.borderColor).toBe(tokens.hairline);
    expect(flat(screen.getByText('history').props.style).color).toBe(tokens.tertiary);
    expect(flat(screen.getByText('hide').props.style).color).toBe(tokens.accent);
    expect(flat(screen.getByText('1,234').props.style).color).toBe(tokens.ink);
    expect(flat(screen.getByText('wordsSpoken').props.style).color).toBe(tokens.secondary);
    expect(flat(screen.getByText('Ship the dark theme').props.style).color).toBe(tokens.ink);
    expect(flat(screen.getByText('seeAllHistory').props.style).color).toBe(tokens.accent);
    expect(flat(screen.getByText('olderRecordings').props.style).color).toBe(tokens.ink);
    // Every glyph on Home is one of the palette's inks or the accent, never a stray colour.
    const glyphs = new Set(screen.getAllByTestId('glyph').map((g) => g.props.accessibilityHint));
    for (const colour of glyphs)
      expect([tokens.ink, tokens.secondary, tokens.tertiary, tokens.accent]).toContain(colour);
  });

  it('keeps the white button raised and the ask on the brand glass', () => {
    renderIn(scheme);
    const white = flat(screen.getByLabelText('dictate').props.style);
    expect(white.experimental_backgroundImage).toBe(
      scheme === 'dark'
        ? 'linear-gradient(180deg, #2B2C34 0%, #23242B 100%)'
        : 'linear-gradient(180deg, #FFFFFF 0%, #F3F4F8 100%)',
    );
    expect(flat(screen.getByText('dictate').props.style).color).toBe(tokens.ink);
    const ask = flat(screen.getByLabelText('allow').props.style);
    expect(ask.experimental_backgroundImage).toBe(
      'linear-gradient(180deg, #5588F0 0%, #3466E2 100%)',
    );
    // A gradient view never gets a border width it didn't have (see PillButton).
    expect(ask.borderWidth).toBe(0);
    expect(flat(screen.getByText('allow').props.style).color).toBe('#FFFFFF');
  });
});

/** Holds state of its own, so a remount would show as a reset count. */
function Counter() {
  const [count, setCount] = useState(0);
  return (
    <Pressable onPress={() => setCount((n) => n + 1)}>
      <Text testID="count">{String(count)}</Text>
    </Pressable>
  );
}

it('switches Home in place: no remount, state kept, new colours', async () => {
  const view = render(
    <ThemeProvider>
      <HomePieces />
      <Counter />
    </ThemeProvider>,
  );
  fireEvent.press(screen.getByTestId('count'));
  fireEvent.press(screen.getByTestId('count'));
  const cardBefore = screen.getByTestId('card');
  expect(flat(cardBefore.props.style).backgroundColor).toBe(lightTheme.surface);

  mockScheme.mockReturnValue('dark');
  await act(async () => {
    view.rerender(
      <ThemeProvider>
        <HomePieces />
        <Counter />
      </ThemeProvider>,
    );
  });

  expect(mockPrepare).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId('count').props.children).toBe('2');
  expect(screen.getByTestId('card')).toBe(cardBefore);
  expect(flat(screen.getByTestId('card').props.style).backgroundColor).toBe(darkTheme.surface);
  expect(flat(screen.getByTestId('page').props.style).backgroundColor).toBe(darkTheme.canvas);
});
