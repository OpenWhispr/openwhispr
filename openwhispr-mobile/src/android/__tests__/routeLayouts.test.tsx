import type React from 'react';
import { render } from '@testing-library/react-native';

type ScreenProps = { name: string; options?: unknown };
const mockScreens: ScreenProps[] = [];
const mockCopy = jest.fn((key: string) => `translated:${key}`);

jest.mock('expo-router', () => {
  const Stack = ({ children }: { children: React.ReactNode }) => children;
  Stack.Screen = (props: ScreenProps) => {
    mockScreens.push(props);
    return null;
  };
  return { Stack, router: { back: jest.fn() } };
});
jest.mock('@/hooks/useAndroidCopy', () => ({ useAndroidCopy: () => ({ copy: mockCopy }) }));
jest.mock('@/components/settings/WorkflowSettingsHeader.android', () => ({
  WorkflowSettingsHeader: () => null,
}));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('@/lib/utils', () => ({ safeHaptics: jest.fn() }));
jest.mock('@/lib/aiWorkflows', () => ({
  WORKFLOW_LABELS: { dictation: 'Dictation' },
  parseWorkflow: (scope: string) => scope,
}));

import AccountLayout from '../../../app-android/(account)/_layout';
import NotesLayout from '../../../app-android/(tabs)/(notes)/_layout';

beforeEach(() => {
  mockScreens.length = 0;
  mockCopy.mockClear();
});

it('keeps account help and device checks', () => {
  render(<AccountLayout />);
  const names = mockScreens.map((screen) => screen.name);
  expect(names).toEqual(expect.arrayContaining(['device-check', 'help']));
  const workflow = mockScreens.find((screen) => screen.name === 'ai-workflow');
  const options = workflow!.options as (props: { route: { params: { scope: string } } }) => {
    title: string;
    header?: unknown;
  };
  const resolved = options({ route: { params: { scope: 'dictation' } } });
  expect(resolved.title).toBe('translated:workflowSettings.dictation');
  expect(Boolean(resolved.header)).toBe(true);
  expect(mockCopy).toHaveBeenCalledTimes(1);
});

// Android never had these iOS screens; they are not part of its route tree.
it('declares no iOS-only account screen', () => {
  render(<AccountLayout />);
  const names = mockScreens.map((screen) => screen.name);
  for (const name of [
    'dictation-agent',
    'keyboard-tone',
    'hardware-keyboard',
    'google-calendar',
    'model-download',
    'diarization-model',
    'parakeet-benchmark',
  ]) {
    expect(names).not.toContain(name);
  }
});

it('keeps the import-audio route registration', () => {
  render(<NotesLayout />);
  expect(mockScreens.some((screen) => screen.name === 'import-audio')).toBe(true);
  expect(mockScreens.find((screen) => screen.name === '[id]')?.options).toEqual(
    expect.objectContaining({ headerShown: false }),
  );
});
