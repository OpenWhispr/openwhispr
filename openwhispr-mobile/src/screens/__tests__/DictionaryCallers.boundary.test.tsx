import React from 'react';
import { View } from 'react-native';
import { cleanupAsync, render } from '@testing-library/react-native';
import DictionaryScreen from '../DictionaryScreen';
import { SnippetsView } from '@/components/features/SnippetsView';

let mockCopyCalls = 0,
  mockTranslationCalls = 0,
  mockHeader: Record<string, any> = {},
  mockEntries: any[] = [];
jest.mock('react-native', () => {
  const native = jest.requireActual('react-native');
  Object.defineProperty(native.Platform, 'OS', { configurable: true, value: 'ios' });
  return native;
});
jest.mock('@/hooks/useAndroidCopy', () => ({
  useAndroidCopy: () => {
    mockCopyCalls++;
    return { copy: (_key: string, fallback: string) => fallback, language: 'en' };
  },
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => {
    mockTranslationCalls++;
    return { t: (key: string) => key };
  },
}));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('@/components/ui/TabScreenHeader', () => ({
  TabScreenHeader: (props: any) => {
    mockHeader = props;
    return null;
  },
}));
jest.mock('@/components/ui/SwipeableCard', () => ({
  SwipeableCard: ({ children }: any) => children,
}));
jest.mock('@/components/ui/SearchField', () => ({ SearchField: () => null }));
jest.mock('@/components/ui/Fab', () => ({ Fab: () => null, FAB_BOTTOM_PADDING: 100 }));
jest.mock('@/components/features/AddWordsSheet', () => ({ AddWordsSheet: () => null }));
jest.mock('@/components/features/AddSnippetSheet', () => ({ AddSnippetSheet: () => null }));
jest.mock('@/components/notes/SyncStatusLabel', () => ({ SyncStatusLabel: () => null }));
jest.mock('@/components/ui/SegmentedControl.android', () => ({ SegmentedControl: () => null }));
jest.mock('@/android/ui', () => ({ AccountButton: () => null }));
jest.mock('@/android/libraryTime', () => ({ formatLibraryTime: () => 'android-date' }));
jest.mock('@/lib/utils', () => ({
  safeHaptics: jest.fn(),
  formatRelativeTime: () => 'upstream-date',
}));
jest.mock('@/lib/alerts', () => ({ confirmDestructive: jest.fn() }));
jest.mock('@/config/colors', () => ({ iosColor: () => '#000' }));
jest.mock('@/store/useDictionaryStore', () => ({
  useDictionaryStore: (select: any) =>
    select({
      entries: [{ word: 'Original', source: 'manual', addedAt: 1, sharedAt: 1 }],
      isLoaded: true,
      load: jest.fn(),
      addWords: jest.fn(),
      removeWord: jest.fn(),
    }),
}));
jest.mock('@/store/useSnippetsStore', () => ({
  useSnippetsStore: (select: any) =>
    select({
      entries: mockEntries,
      addSnippet: jest.fn(),
      updateSnippet: jest.fn(),
      removeSnippet: jest.fn(),
    }),
}));
jest.mock('@/store/useSharedDictionaryStore', () => ({
  useSharedDictionaryStore: (select: any) =>
    select({ summary: null, sharedWordsLower: new Set(), hiddenOnlyKeys: new Set(['original']) }),
}));

beforeEach(() => {
  mockCopyCalls = 0;
  mockTranslationCalls = 0;
  mockHeader = {};
  mockEntries = [];
});
afterEach(async () => {
  await cleanupAsync();
});
it('keeps Android copy and mode subscriptions out of the default dictionary', () => {
  render(<DictionaryScreen />);
  expect(mockCopyCalls).toBe(0);
  expect(mockTranslationCalls).toBe(0);
});
it('retains the upstream default row accessibility props and metadata', () => {
  const screen = render(<DictionaryScreen />);
  expect(screen.getByText('Manual · upstream-date · Hidden for you')).toBeTruthy();
  const row = screen
    .UNSAFE_getAllByType(View)
    .find(
      (node) =>
        node.props.className ===
        'flex-row items-center gap-3 bg-secondarySystemGroupedBackground px-4 py-2.5',
    );
  expect(row).toBeDefined();
  expect(row!.props.accessibilityActions).toBeUndefined();
  expect(row!.props.onAccessibilityAction).toBeUndefined();
  expect(row!.props.accessible).toBeUndefined();
});
it('retains an absent default account header slot', () => {
  render(<DictionaryScreen />);
  expect(Object.hasOwn(mockHeader, 'right')).toBe(false);
});
it('keeps Android copy hooks out of default snippet views, empty states and rows', () => {
  const screen = render(<SnippetsView />);
  expect(screen.getByText('Add your first snippet')).toBeTruthy();
  mockEntries = [{ trigger: 'original', replacement: 'Original body' }];
  screen.rerender(<SnippetsView />);
  expect(screen.getByText('original')).toBeTruthy();
  expect(mockCopyCalls).toBe(0);
});
