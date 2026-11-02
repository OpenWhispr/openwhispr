import React from 'react';
import { render, screen } from '@testing-library/react-native';
import DictionaryScreen from '../DictionaryScreen';
import type { DictionaryEntry } from '@/store/useDictionaryStore';
import type { SharedDictionarySummary } from '@/store/useSharedDictionaryStore';

let mockEntries: DictionaryEntry[] = [];
let mockSummary: SharedDictionarySummary | null = null;
let mockSharedWordsLower = new Set<string>();
let mockHiddenOnlyKeys = new Set<string>();

jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('@/components/ui/TabScreenHeader', () => ({ TabScreenHeader: () => null }));
jest.mock('@/components/ui/SwipeableCard', () => ({
  SwipeableCard: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('@/components/ui/SearchField', () => ({ SearchField: () => null }));
jest.mock('@/components/ui/Fab', () => ({ Fab: () => null, FAB_BOTTOM_PADDING: 0 }));
jest.mock('@/components/features/AddWordsSheet', () => ({ AddWordsSheet: () => null }));
jest.mock('@/components/features/SnippetsView', () => ({ SnippetsView: () => null }));
jest.mock('@/components/notes/SyncStatusLabel', () => ({ SyncStatusLabel: () => null }));
jest.mock('@/lib/utils', () => ({
  safeHaptics: jest.fn(),
  formatRelativeTime: () => 'today',
}));
jest.mock('@/store/useDictionaryStore', () => ({
  useDictionaryStore: (selector: (state: unknown) => unknown) =>
    selector({
      entries: mockEntries,
      isLoaded: true,
      load: jest.fn(),
      addWords: jest.fn(),
      removeWord: jest.fn(),
    }),
}));
jest.mock('@/store/useSharedDictionaryStore', () => ({
  useSharedDictionaryStore: (selector: (state: unknown) => unknown) =>
    selector({
      summary: mockSummary,
      sharedWordsLower: mockSharedWordsLower,
      hiddenOnlyKeys: mockHiddenOnlyKeys,
    }),
}));

const entry = (word: string, sharedAt: number | null = null): DictionaryEntry => ({
  word,
  source: 'manual',
  addedAt: 1,
  sharedAt,
});

beforeEach(() => {
  mockEntries = [entry('Kubernetes')];
  mockSummary = null;
  mockSharedWordsLower = new Set();
  mockHiddenOnlyKeys = new Set();
});

it('shows the shared line with count and workspace name', () => {
  mockSummary = { count: 12, workspaceName: 'Acme' };
  render(<DictionaryScreen />);
  expect(
    screen.getByText('12 team words from Acme also apply. Manage them on desktop.'),
  ).toBeOnTheScreen();
});

it('uses the singular form for one team word', () => {
  mockSummary = { count: 1, workspaceName: 'Acme' };
  render(<DictionaryScreen />);
  expect(
    screen.getByText('1 team word from Acme also applies. Manage it on desktop.'),
  ).toBeOnTheScreen();
});

it('hides it when summary is null', () => {
  render(<DictionaryScreen />);
  expect(screen.queryByText(/team words? from/)).not.toBeOnTheScreen();
});

it('shows it in the empty state', () => {
  mockEntries = [];
  mockSummary = { count: 3, workspaceName: 'Acme' };
  render(<DictionaryScreen />);
  expect(screen.getByText('Add your first word')).toBeOnTheScreen();
  expect(
    screen.getByText('3 team words from Acme also apply. Manage them on desktop.'),
  ).toBeOnTheScreen();
});

it('a moved word is hidden from Personal while shared, shown again once its shared copy is gone', () => {
  mockEntries = [entry('Kubernetes'), entry('Grafana', 5)];
  mockSharedWordsLower = new Set(['grafana']);
  const view = render(<DictionaryScreen />);
  expect(screen.getByText('Kubernetes')).toBeOnTheScreen();
  expect(screen.queryByText('Grafana')).not.toBeOnTheScreen();

  mockSharedWordsLower = new Set();
  view.rerender(<DictionaryScreen />);
  expect(screen.getByText('Grafana')).toBeOnTheScreen();
});

it('keeps a word without sharedAt in Personal even when a shared word matches it', () => {
  mockEntries = [entry('Grafana')];
  mockSharedWordsLower = new Set(['grafana']);
  render(<DictionaryScreen />);
  expect(screen.getByText('Grafana')).toBeOnTheScreen();
});

it('treats a list of only moved words as the empty state', () => {
  mockEntries = [entry('Grafana', 5)];
  mockSharedWordsLower = new Set(['grafana']);
  render(<DictionaryScreen />);
  expect(screen.getByText('Add your first word')).toBeOnTheScreen();
});

it('names the moved words in the shared line, so they can be added back', () => {
  mockEntries = [entry('Kubernetes'), entry('Grafana', 5), entry('Loki', 5)];
  mockSharedWordsLower = new Set(['grafana', 'loki']);
  mockSummary = { count: 12, workspaceName: 'Acme' };
  render(<DictionaryScreen />);
  expect(
    screen.getByText(
      '12 team words from Acme also apply. Grafana and Loki were moved there from your list. Manage them on desktop.',
    ),
  ).toBeOnTheScreen();
});

it('counts the moved words when there are many', () => {
  mockEntries = ['A1', 'B2', 'C3', 'D4'].map((word) => entry(word, 5));
  mockSharedWordsLower = new Set(['a1', 'b2', 'c3', 'd4']);
  mockSummary = { count: 4, workspaceName: 'Acme' };
  render(<DictionaryScreen />);
  expect(
    screen.getByText(
      '4 team words from Acme also apply. All 4 were moved from your list. Manage them on desktop.',
    ),
  ).toBeOnTheScreen();
});

it('names a single moved word in a sentence of its own', () => {
  mockEntries = [entry('Kubernetes'), entry('Grafana', 5)];
  mockSharedWordsLower = new Set(['grafana']);
  mockSummary = { count: 1, workspaceName: 'Acme' };
  render(<DictionaryScreen />);
  expect(
    screen.getByText(
      '1 team word from Acme also applies. Grafana was moved there from your list. Manage it on desktop.',
    ),
  ).toBeOnTheScreen();
});

it('counts some of the team words as moved when there are many', () => {
  mockEntries = ['A1', 'B2', 'C3', 'D4'].map((word) => entry(word, 5));
  mockSharedWordsLower = new Set(['a1', 'b2', 'c3', 'd4']);
  mockSummary = { count: 9, workspaceName: 'Acme' };
  render(<DictionaryScreen />);
  expect(
    screen.getByText(
      '9 team words from Acme also apply. 4 of them were moved from your list. Manage them on desktop.',
    ),
  ).toBeOnTheScreen();
});

it('reads a workspace without a name as "your workspace"', () => {
  mockSummary = { count: 2, workspaceName: '  ' };
  render(<DictionaryScreen />);
  expect(
    screen.getByText('2 team words from your workspace also apply. Manage them on desktop.'),
  ).toBeOnTheScreen();
});

// Its only shared copy is hidden, so it neither applies nor leaves Personal.
it('shows a moved word whose shared copy the member hid, marked as hidden', () => {
  mockEntries = [entry('Kubernetes'), entry('Grafana', 5)];
  mockHiddenOnlyKeys = new Set(['grafana']);
  render(<DictionaryScreen />);
  expect(screen.getByText('Grafana')).toBeOnTheScreen();
  expect(screen.getByText('Manual · today · Hidden for you')).toBeOnTheScreen();
  expect(screen.getByText('Manual · today')).toBeOnTheScreen();
});

it('never marks a personal word that was not moved', () => {
  mockEntries = [entry('Grafana')];
  mockHiddenOnlyKeys = new Set(['grafana']);
  render(<DictionaryScreen />);
  expect(screen.queryByText(/Hidden for you/)).not.toBeOnTheScreen();
});
