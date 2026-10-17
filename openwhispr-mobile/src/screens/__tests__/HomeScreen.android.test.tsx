import React from 'react';
import { render, screen } from '@testing-library/react-native';

jest.mock('expo-router', () => ({ router: { push: jest.fn() }, useFocusEffect: jest.fn() }));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn() }));
let mockUser: { id: string } | null = null;
let mockSync = false;
let mockInsights = {
  consentPaused: false,
  scope: 'device',
  ledger: {
    events: [{ event_id: 'one', word_count: 42 }],
    acknowledged: [] as string[],
    summary: undefined as { totalWords: number; totalDictations: number } | undefined,
  },
  status: 'idle',
};
jest.mock('@/android/insights', () => ({
  refreshInsights: jest.fn(),
  useInsights: () => mockInsights,
}));
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: (select: any) =>
    select({ config: { insightsSyncEnabled: mockSync, androidHistoryDays: 30 } }),
}));
jest.mock('@/android/bubbleResult', () => ({ useBubbleResult: () => ({}) }));
jest.mock('@/android/Practice', () => ({ Practice: () => null }));
jest.mock('@/android/pipeline', () => ({ applyHistoryRetention: jest.fn(async () => {}) }));
jest.mock('@/hooks/useAppInit', () => ({ useAppInit: jest.fn() }));
jest.mock('@/hooks/useFileUpload', () => ({ useFileUpload: () => ({}) }));
jest.mock('@/hooks/useSuperwallGate', () => ({ useSuperwallGate: () => ({}) }));
jest.mock('@/lib/inferenceRouting', () => ({ getTranscriptionProvider: () => 'local' }));
jest.mock('@/lib/accountAccess', () => ({}));
jest.mock('@/lib/superwall', () => ({}));
jest.mock('@/store/useAuthStore', () => ({ useAuthStore: () => mockUser }));
jest.mock('@/store/useUsageStore', () => ({ useUsageStore: () => null }));
jest.mock('@/store/useTranscriptStore', () => ({
  useTranscriptStore: () => [
    { id: 'done', text: 'Hello there.', status: 'completed', createdAt: 1, provider: 'local' },
    { id: 'legacy', text: 'One more dictation.', createdAt: 2, provider: 'local' },
    {
      id: 'failed',
      text: 'Unfinished raw audio',
      status: 'failed',
      createdAt: 3,
      provider: 'local',
      errorMessage: 'Unreadable audio',
      audioUrl: 'file:///invalid.wav',
    },
  ],
}));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/android/ui', () => {
  const { View, Text } = require('react-native');
  return {
    Page: View,
    Card: View,
    Row: () => null,
    styles: {},
    Button: ({ label }: { label: string }) => <Text>{label}</Text>,
  };
});

import AndroidHome from '../HomeScreen.android';

it('uses durable dictation statistics rather than retained transcripts and keeps failed audio retryable', () => {
  render(<AndroidHome />);
  expect(screen.getByText('1')).toBeTruthy();
  expect(screen.getByText('42')).toBeTruthy();
  expect(screen.getByText('Unreadable audio')).toBeTruthy();
  expect(screen.getByText('retry')).toBeTruthy();
});

beforeEach(() => {
  mockUser = null;
  mockSync = false;
  mockInsights = {
    consentPaused: false,
    scope: 'device',
    ledger: { events: [{ event_id: 'one', word_count: 42 }], acknowledged: [], summary: undefined },
    status: 'idle',
  };
});
it('shows unavailable account counts while loading rather than local counts presented as account totals', () => {
  mockUser = { id: 'a' };
  mockSync = true;
  mockInsights.scope = 'account:a';
  mockInsights.status = 'loading';
  render(<AndroidHome />);
  expect(screen.getAllByText('—')).toHaveLength(2);
  expect(screen.queryByText('42')).toBeNull();
  expect(screen.getByText('statsLoading')).toBeTruthy();
});
it('keeps cached account totals visible offline without adding pending local words', () => {
  mockUser = { id: 'a' };
  mockSync = true;
  mockInsights.scope = 'account:a';
  mockInsights.status = 'offline';
  mockInsights.ledger.summary = { totalWords: 100, totalDictations: 5 };
  render(<AndroidHome />);
  expect(screen.getByText('100')).toBeTruthy();
  expect(screen.getByText('5')).toBeTruthy();
  expect(screen.getByText('statsOffline')).toBeTruthy();
  expect(screen.queryByText('142')).toBeNull();
});
it('distinguishes a confirmed zero from unavailable account totals and labels pending dictations', () => {
  mockUser = { id: 'a' };
  mockSync = true;
  mockInsights.scope = 'account:a';
  mockInsights.ledger.summary = { totalWords: 0, totalDictations: 0 };
  render(<AndroidHome />);
  expect(screen.getAllByText('0')).toHaveLength(2);
  expect(screen.getByText('statsPending')).toBeTruthy();
});
it('hides the previous account totals immediately when the account changes', () => {
  mockUser = { id: 'b' };
  mockSync = true;
  mockInsights.scope = 'account:a';
  mockInsights.ledger.summary = { totalWords: 100, totalDictations: 5 };
  render(<AndroidHome />);
  expect(screen.queryByText('100')).toBeNull();
  expect(screen.getAllByText('—')).toHaveLength(2);
  expect(screen.getByText('statsLoading')).toBeTruthy();
});
it('labels unavailable offline totals without inventing zero', () => {
  mockUser = { id: 'a' };
  mockSync = true;
  mockInsights.scope = 'account:a';
  mockInsights.status = 'offline';
  render(<AndroidHome />);
  expect(screen.getAllByText('—')).toHaveLength(2);
  expect(screen.getByText('statsUnavailable')).toBeTruthy();
});

it('shows device counts with a paused label after an opt-out fails to persist', () => {
  mockUser = { id: 'a' };
  mockSync = true;
  mockInsights.scope = 'account:a';
  mockInsights.consentPaused = true;
  render(<AndroidHome />);
  expect(screen.getByText('42')).toBeTruthy();
  expect(screen.getByText('statsPaused')).toBeTruthy();
  expect(screen.queryByText('statsLoading')).toBeNull();
});
