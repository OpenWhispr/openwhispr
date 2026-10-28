import React from 'react';
import { render } from '@testing-library/react-native';
import type { NativeStackNavigationOptions } from '@react-navigation/native-stack';

type ScreenProps = { name: string; options?: NativeStackNavigationOptions };

let mockStackOptions: NativeStackNavigationOptions = {};
const mockScreens: ScreenProps[] = [];
let mockSegments: string[] = [];
let mockTabsHidden: boolean | undefined;
const mockTabNames: string[] = [];

jest.mock('expo-router', () => {
  const Stack = ({
    screenOptions,
    children,
  }: {
    screenOptions: NativeStackNavigationOptions;
    children: React.ReactNode;
  }): React.ReactNode => {
    mockStackOptions = screenOptions;
    return children;
  };
  Stack.Screen = (props: ScreenProps): null => {
    mockScreens.push(props);
    return null;
  };
  return { Stack, useSegments: () => mockSegments };
});
jest.mock('expo-router/unstable-native-tabs', () => {
  const NativeTabs = ({
    hidden,
    children,
  }: {
    hidden: boolean;
    children: React.ReactNode;
  }): React.ReactNode => {
    mockTabsHidden = hidden;
    return children;
  };
  const Trigger = ({
    name,
    children,
  }: {
    name: string;
    children: React.ReactNode;
  }): React.ReactNode => {
    mockTabNames.push(name);
    return children;
  };
  Trigger.Label = (): null => null;
  Trigger.Icon = (): null => null;
  NativeTabs.Trigger = Trigger;
  return { NativeTabs };
});

import ChatLayout from '../(tabs)/(chat)/_layout';
import TabsLayout from '../(tabs)/_layout';

// What a screen ends up with: the stack's defaults under its own options.
const resolvedOptions = (name: string): NativeStackNavigationOptions => {
  const screen = mockScreens.find((candidate) => candidate.name === name);
  if (!screen) throw new Error(`No screen named ${name}`);
  return { ...mockStackOptions, ...screen.options };
};

beforeEach(() => {
  mockScreens.length = 0;
  mockTabsHidden = undefined;
  mockTabNames.length = 0;
});

describe('Chat stack', () => {
  it('gives the note sub-screens a native bar with a back button', () => {
    render(<ChatLayout />);

    for (const name of ['note/actions', 'note/voice-enrollment']) {
      expect(resolvedOptions(name).headerShown).not.toBe(false);
    }
    expect(resolvedOptions('note/actions').title).toBe('Actions');
    expect(resolvedOptions('note/voice-enrollment').title).toBe('Voice Sample');
  });

  it('hides the native bar on the screens that draw their own header', () => {
    render(<ChatLayout />);

    for (const name of ['index', '[id]', 'history', 'note/[id]']) {
      expect(resolvedOptions(name).headerShown).toBe(false);
    }
  });
});

describe('Tab bar on the Chat tab', () => {
  it('puts Chat third, after Notes', () => {
    mockSegments = ['(tabs)', '(record)'];

    render(<TabsLayout />);

    expect(mockTabNames).toEqual(['(record)', '(notes)', '(chat)', '(dictionary)']);
  });

  it.each([
    [['(tabs)', '(chat)'], false],
    [['(tabs)', '(chat)', 'index'], false],
    [['(tabs)', '(chat)', 'history'], false],
    [['(tabs)', '(chat)', '[id]'], true],
    [['(tabs)', '(chat)', 'note', '[id]'], true],
  ])('for %j is hidden: %s', (segments, hidden) => {
    mockSegments = segments;

    render(<TabsLayout />);

    expect(mockTabsHidden).toBe(hidden);
  });
});
