import React from 'react';
import { Platform } from 'react-native';
import { render, screen } from '@testing-library/react-native';
import AIModelsScreen from '../AIModelsScreen';

jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
jest.mock('@/hooks/useConfigToggle', () => ({ useConfigToggle: () => jest.fn() }));
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: (selector: (state: unknown) => unknown) =>
    selector({ config: { defaultMode: 'cloud', appleLocalIntelligenceEnabled: false } }),
}));
jest.mock('@/store/useProcessingModeStore', () => ({
  useProcessingModeStore: () => ({ activeMode: 'cloud' }),
}));
jest.mock('@/lib/localReasoning', () => ({ getLocalReasoningReadiness: jest.fn() }));

const originalOS = Platform.OS;
afterEach(() => {
  Platform.OS = originalOS;
});

it('offers Bring Your Own Key on iOS', () => {
  Platform.OS = 'ios';
  render(<AIModelsScreen />);
  expect(screen.getByText('Bring Your Own Key')).toBeOnTheScreen();
});

it('never shows Bring Your Own Key on Android', () => {
  Platform.OS = 'android';
  render(<AIModelsScreen />);
  expect(screen.getByText('Speech to Text')).toBeOnTheScreen();
  expect(screen.queryByText('Bring Your Own Key')).not.toBeOnTheScreen();
});
