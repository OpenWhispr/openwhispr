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
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: (pick: (s: object) => unknown) => pick({ user: null, isGuest: true }),
}));
jest.mock('@/android/store/useAuthStore', () => jest.requireMock('@/store/useAuthStore'));
jest.mock('../home/strings', () => ({ useHomeT: () => (key: string) => key }));
jest.mock('../dictionary/strings', () => ({
  useDictionaryT: () => (key: string) => key,
  dictionaryT: (key: string) => key,
}));
jest.mock('../dictionary/learned', () => ({
  keepLearned: jest.fn(),
  restoreLearned: jest.fn(),
  unlearn: jest.fn(),
}));
jest.mock('../settings/kit', () => ({
  showToast: jest.fn(),
  useReduceMotion: () => true,
  relativeTime: () => 'now',
}));
jest.mock('react-native-gesture-handler', () => {
  const chain: Record<string, () => unknown> = {};
  for (const name of ['activeOffsetX', 'failOffsetY', 'onUpdate', 'onEnd'])
    chain[name] = () => chain;
  return {
    Gesture: { Pan: () => chain },
    GestureDetector: ({ children }: { children: React.ReactNode }) => children,
  };
});
jest.mock('react-native-reanimated', () => {
  const { View } = require('react-native');
  return {
    __esModule: true,
    default: { View },
    Easing: { out: () => undefined, cubic: undefined, linear: undefined, inOut: () => undefined },
    interpolate: () => 0,
    runOnJS: (fn: unknown) => fn,
    useSharedValue: (value: number) => ({ value }),
    useAnimatedStyle: () => ({}),
    withTiming: (value: number) => value,
    withRepeat: (value: number) => value,
    cancelAnimation: () => undefined,
  };
});

import { ThemeProvider } from '../ThemeProvider';
import { darkTheme, lightTheme } from '../theme';
import { ReviewStack } from '../dictionary/ReviewStack';
import { DictionaryEmpty } from '../dictionary/Empty';
import { Field } from '../dictionary/Field';

type ReactTestInstance = ReturnType<typeof screen.getByText>;
const mockScheme = useColorScheme as jest.MockedFunction<typeof useColorScheme>;
const flat = (style: unknown) => StyleSheet.flatten(style as never) as Record<string, unknown>;

const item = (word: string) =>
  ({
    word,
    source: 'learned',
    info: { from: 'Sinty', origin: { kind: 'app' }, learnedAt: Date.now(), keptAt: null },
  }) as never;
const items = [item('Synty'), item('Cameron'), item('Zorblax')];

function inTheme(scheme: 'light' | 'dark', node: React.ReactElement) {
  mockScheme.mockReturnValue(scheme);
  return render(<ThemeProvider>{node}</ThemeProvider>);
}

/** The front card reports its height, so the cards behind it draw. */
function layOut(height: number) {
  const front = screen.UNSAFE_root.findAll(
    (node: ReactTestInstance) =>
      typeof node.type === 'string' && node.props.accessibilityActions != null,
  )[0];
  act(() => {
    front.props.onLayout({ nativeEvent: { layout: { width: 360, height } } });
  });
}

/** Views behind the front card, deepest first, as ReviewStack draws them. */
function backCards() {
  return screen.UNSAFE_root.findAll(
    (node: ReactTestInstance) =>
      typeof node.type !== 'string' && node.props.accessibilityElementsHidden === true,
  ).map((node: ReactTestInstance) => flat(node.props.style));
}

beforeEach(() => {
  mockScheme.mockReturnValue('light');
  mockPrepare.mockClear();
});

describe.each([
  ['light', lightTheme],
  ['dark', darkTheme],
] as const)('Dictionary in %s', (scheme, tokens) => {
  it('stacks whole rounded cards behind the front one, 12 px down and 10/22 px in', () => {
    inTheme(scheme, <ReviewStack items={items} />);
    layOut(120);
    const cards: Record<string, unknown>[] = backCards();
    // Unique host views only (a composite and its host share props).
    const unique = cards.filter(
      (style, index) => cards.findIndex((other) => other.top === style.top) === index,
    );
    expect(unique.map((card) => [card.top, card.left, card.right])).toEqual([
      [24, 22, 22],
      [12, 10, 10],
    ]);
    for (const card of unique) {
      expect(card.height).toBe(120);
      expect(card.borderRadius).toBe(16);
      expect(card.backgroundColor).toBe(tokens.surface);
      expect(card.borderColor).toBe(tokens.hairline);
    }
  });

  it('draws the front card and its words from that palette', () => {
    inTheme(scheme, <ReviewStack items={items} />);
    expect(flat(screen.getByText('Synty').props.style).color).toBe(tokens.ink);
    expect(flat(screen.getByText('youFixedInApp').props.style).color).toBe(tokens.secondary);
    expect(flat(screen.getByText('reviewPosition').props.style).color).toBe(tokens.tertiary);
    expect(screen.getAllByTestId('glyph')[0].props.accessibilityHint).toBe(tokens.accent);
  });

  it('keeps the empty state on the brand glass with white ink', () => {
    inTheme(scheme, <DictionaryEmpty variant="words" onAdd={() => undefined} />);
    expect(flat(screen.getByText('emptyTitle').props.style).color).toBe(tokens.ink);
    expect(flat(screen.getByText('emptyBody').props.style).color).toBe(tokens.secondary);
    expect(flat(screen.getByText('addFirstWord').props.style).color).toBe(tokens.onGlass);
    expect(
      flat(screen.getByText('OpenWhispr', { includeHiddenElements: true }).props.style).color,
    ).toBe(tokens.accent);
  });

  it('gives a field the theme ink, placeholder and focus ring', () => {
    inTheme(scheme, <Field testID="field" placeholder="type" />);
    const field = screen.getByTestId('field');
    expect(field.props.placeholderTextColor).toBe(tokens.tertiary);
    expect(flat(field.props.style).color).toBe(tokens.ink);
    expect(flat(field.props.style).borderColor).toBe(tokens.fieldHairline);
    fireEvent(field, 'focus');
    const ring = scheme === 'dark' ? 'rgba(110,155,255,0.55)' : 'rgba(21,85,212,0.55)';
    expect(flat(screen.getByTestId('field').props.style).borderColor).toBe(ring);
  });
});

it('switches the review stack and a field in place: no remount, typed text kept', async () => {
  const tree = () => (
    <ThemeProvider>
      <ReviewStack items={items} />
      <Field testID="field" defaultValue="Synty" />
    </ThemeProvider>
  );
  mockScheme.mockReturnValue('light');
  const view = render(tree());
  layOut(120);
  const field = screen.getByTestId('field');
  fireEvent(field, 'focus');
  fireEvent.changeText(field, 'Syntyy');
  const front = screen.getByText('Synty');
  mockScheme.mockReturnValue('dark');
  await act(async () => {
    view.rerender(tree());
  });
  expect(mockPrepare).toHaveBeenCalled();
  expect(screen.getByText('Synty')).toBe(front);
  expect(screen.getByTestId('field')).toBe(field);
  expect(flat(front.props.style).color).toBe(darkTheme.ink);
  expect(backCards().length).toBeGreaterThan(0);
  expect(backCards()[0].backgroundColor).toBe(darkTheme.surface);
  // Still focused: the ring is the dark accent's.
  expect(flat(screen.getByTestId('field').props.style).borderColor).toBe('rgba(110,155,255,0.55)');
});
