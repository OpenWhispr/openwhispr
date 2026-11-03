import React from 'react';
import { Switch } from 'react-native';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { DictationAgentScreen } from '../DictationAgentScreen';

let mockActiveMode = 'providers';
let mockConfig: Record<string, unknown> = { defaultMode: 'providers' };
const mockUpdateConfig = jest.fn();

jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('@/hooks/useConfigToggle', () => ({ useConfigToggle: () => jest.fn() }));
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: (selector: (state: unknown) => unknown) =>
    selector({ config: mockConfig, updateConfig: mockUpdateConfig }),
}));
jest.mock('@/store/useProcessingModeStore', () => ({
  useProcessingModeStore: (selector: (state: unknown) => unknown) =>
    selector({ activeMode: mockActiveMode }),
}));

const NOTICE = /skips the voice assistant until you choose a provider for it in AI Models/;

beforeEach(() => {
  jest.clearAllMocks();
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

// The voice assistant runs its own selection, so Local Mode leaves it on.
it('keeps the voice assistant on in Local Mode', () => {
  mockActiveMode = 'private';
  mockConfig = { defaultMode: 'private', dictationAgentEnabled: true };
  render(<DictationAgentScreen />);
  expect(screen.queryByText(/Local Mode/)).not.toBeOnTheScreen();
  const [enable] = screen.UNSAFE_getAllByType(Switch);
  expect(enable.props.value).toBe(true);
  expect(enable.props.disabled).toBe(false);
});

it('switches only the voice assistant, keeping note chat as it was', () => {
  mockConfig = {
    defaultMode: 'providers',
    inference: { agent: { mode: 'providers', providerId: 'groq', modelId: 'llama' } },
  };
  render(<DictationAgentScreen />);
  expect(screen.queryByText(/Also turns note chat/)).toBeNull();
  fireEvent(screen.UNSAFE_getAllByType(Switch)[0], 'valueChange', false);
  expect(mockUpdateConfig).toHaveBeenCalledWith({ dictationAgentEnabled: false });
});

// The voice assistant is the keyboard's compose wand; saying its name while dictating gives no
// command.
it('describes the wand, not a spoken command', () => {
  render(<DictationAgentScreen />);
  expect(screen.getByText(/Tap the wand on the OpenWhispr keyboard/)).toBeTruthy();
  expect(screen.getByText(/Saying its name while dictating gives no command/)).toBeTruthy();
  // The switch reads off wherever the assistant can't run, though the keyboard still shows the
  // wand there (dimmed in Local Mode), so it describes using the wand rather than showing it.
  expect(screen.getByText('Use the wand on the OpenWhispr keyboard.')).toBeTruthy();
  expect(screen.queryByText(/rewrites what you said/)).toBeNull();
});
