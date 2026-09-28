import React from 'react';
import { render, screen } from '@testing-library/react-native';

jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: (selector: (state: unknown) => unknown) =>
    selector({ config: null, updateConfig: jest.fn() }),
}));
jest.mock('@/hooks/useConfigToggle', () => ({ useConfigToggle: () => jest.fn() }));
jest.mock('../../../modules/live-activity/src', () => ({
  LiveActivity: { isDictationModeEnabled: () => false, setDictationMode: jest.fn() },
}));
// Private mode, so the "needs Cloud" notice renders too.
jest.mock('@/store/useProcessingModeStore', () => ({
  useProcessingModeStore: (selector: (state: unknown) => unknown) =>
    selector({ activeMode: 'private' }),
}));
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: (selector: (state: unknown) => unknown) =>
    selector({ user: { id: 'user', isAnonymous: false }, isGuest: false }),
}));
jest.mock('@/sync/useSyncStore', () => ({
  useSyncStore: () => ({
    status: 'idle',
    lastSyncAt: null,
    subscriptionRequired: false,
    policyBlocked: false,
  }),
}));
jest.mock('@/sync/syncEngine', () => ({ requestSync: jest.fn() }));
jest.mock('@/store/useUsageStore', () => ({
  useUsageStore: (selector: (state: unknown) => unknown) =>
    selector({ usage: null, load: jest.fn(async () => undefined) }),
}));
jest.mock('@/store/useNotesStore', () => ({
  useNotesStore: (selector: (state: unknown) => unknown) =>
    selector({
      voiceProfiles: [],
      loadVoiceProfiles: jest.fn(async () => undefined),
      deleteAllVoiceProfiles: jest.fn(async () => undefined),
    }),
}));
jest.mock('@/lib/alerts', () => ({ confirmDestructive: jest.fn() }));

import { DictationAgentScreen } from '../DictationAgentScreen';
import PreferencesScreen from '../PreferencesScreen';
import PrivacyDataScreen from '../PrivacyDataScreen';

// The feature is the voice assistant everywhere users meet it, matching onboarding and desktop.
it('lists the voice assistant in Preferences', () => {
  render(<PreferencesScreen />);
  expect(screen.getByText('Voice Assistant')).toBeTruthy();
  expect(screen.getByText('Trigger AI actions by saying your assistant’s name')).toBeTruthy();
  expect(screen.queryByText(/agent/i)).toBeNull();
});

it('names the voice assistant throughout its settings screen', () => {
  render(<DictationAgentScreen />);
  expect(screen.getByText('Enable Voice Assistant')).toBeTruthy();
  expect(screen.getByText('Assistant Name')).toBeTruthy();
  expect(screen.getByText(/Voice Assistant needs Cloud or Bring Your Own Key mode/)).toBeTruthy();
  expect(screen.queryByText(/agent/i)).toBeNull();
});

it('names the voice assistant in Privacy & Data', () => {
  render(<PrivacyDataScreen />);
  expect(screen.getByText('Voice Assistant Context')).toBeTruthy();
  expect(screen.queryByText(/Dictation Agent/)).toBeNull();
});
