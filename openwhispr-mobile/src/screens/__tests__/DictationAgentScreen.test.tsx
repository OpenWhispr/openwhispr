import React from 'react';
import { Switch } from 'react-native';
import { render, screen } from '@testing-library/react-native';
import { DictationAgentScreen } from '../DictationAgentScreen';

let mockActiveMode = 'providers';
let mockConfig: Record<string, unknown> = { defaultMode: 'providers' };

jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('@/hooks/useConfigToggle', () => ({ useConfigToggle: () => jest.fn() }));
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: (selector: (state: unknown) => unknown) =>
    selector({ config: mockConfig, updateConfig: jest.fn() }),
}));
jest.mock('@/store/useProcessingModeStore', () => ({
  useProcessingModeStore: (selector: (state: unknown) => unknown) =>
    selector({ activeMode: mockActiveMode }),
}));

const NOTICE = /skips the voice assistant until Chat & Voice Assistant has a selection/;

beforeEach(() => {
  mockActiveMode = 'providers';
  mockConfig = { defaultMode: 'providers' };
});

it('does not look enabled while Bring Your Own Key skips the voice assistant', () => {
  render(<DictationAgentScreen />);
  expect(screen.getByText(NOTICE)).toBeTruthy();
  expect(screen.UNSAFE_getAllByType(Switch).every((toggle) => toggle.props.disabled)).toBe(true);
});

it('is enabled once the voice assistant has a Bring Your Own Key selection', () => {
  mockConfig = {
    defaultMode: 'providers',
    inference: { agent: { mode: 'providers', providerId: 'groq', modelId: 'llama' } },
  };
  render(<DictationAgentScreen />);
  expect(screen.queryByText(NOTICE)).not.toBeOnTheScreen();
  expect(screen.UNSAFE_getAllByType(Switch).some((toggle) => toggle.props.disabled)).toBe(false);
});

it('asks for Cloud or Bring Your Own Key in On-Device mode', () => {
  mockActiveMode = 'private';
  render(<DictationAgentScreen />);
  expect(screen.getByText(/Voice Assistant needs Cloud or Bring Your Own Key mode/)).toBeTruthy();
});
