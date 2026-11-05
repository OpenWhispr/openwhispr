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
jest.mock('@/components/settings/WorkflowSettingsHeader', () => ({
  WorkflowSettingsHeader: () => null,
}));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('@/lib/utils', () => ({ safeHaptics: jest.fn() }));
jest.mock('@/lib/aiWorkflows', () => ({
  WORKFLOW_LABELS: { dictation: 'Dictation' },
  parseWorkflow: (scope: string) => scope,
}));

import AccountLayout from '../(account)/_layout';
import AndroidAccountLayout from '../(account)/_layout.android';
import NotesLayout from '../(tabs)/(notes)/_layout';
import AndroidNotesLayout from '../(tabs)/(notes)/_layout.android';

beforeEach(() => {
  mockScreens.length = 0;
  mockCopy.mockClear();
});

it.each([
  [AccountLayout, false],
  [AndroidAccountLayout, true],
])('keeps account help and device checks on Android (%p)', (Layout, android) => {
  render(<Layout />);
  const names = mockScreens.map((screen) => screen.name);
  expect(names.includes('device-check')).toBe(android);
  expect(names.includes('help')).toBe(android);
  const workflow = mockScreens.find((screen) => screen.name === 'ai-workflow');
  const options = workflow!.options as (props: { route: { params: { scope: string } } }) => {
    title: string;
    header?: unknown;
  };
  const resolved = options({ route: { params: { scope: 'dictation' } } });
  expect(resolved.title).toBe(android ? 'translated:workflowSettings.dictation' : 'Dictation');
  expect(Boolean(resolved.header)).toBe(android);
  expect(mockCopy).toHaveBeenCalledTimes(android ? 1 : 0);
});

it.each([
  [NotesLayout, false],
  [AndroidNotesLayout, true],
])('keeps the import-audio route registration on Android (%p)', (Layout, android) => {
  render(<Layout />);
  expect(mockScreens.some((screen) => screen.name === 'import-audio')).toBe(android);
  expect(mockScreens.find((screen) => screen.name === '[id]')?.options).toEqual(
    expect.objectContaining({ headerShown: false }),
  );
});
