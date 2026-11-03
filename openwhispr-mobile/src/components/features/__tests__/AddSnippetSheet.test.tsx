import React from 'react';
import { Platform, TextInput } from 'react-native';
import { act, fireEvent, render } from '@testing-library/react-native';
import { createInstance } from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from '@/locales/en/translation.json';
import { AddSnippetSheet } from '../AddSnippetSheet';
import { confirmDestructive } from '@/lib/alerts';

jest.mock('@/lib/alerts', () => ({ confirmDestructive: jest.fn() }));
jest.mock('@/lib/utils', () => ({ safeHaptics: jest.fn() }));
jest.mock('@/lib/fonts', () => ({ AppFont: {} }));
jest.mock('@/config/colors', () => ({ iosColor: () => '#000' }));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/FormSheet', () => {
  const { View, Button } = require('react-native');
  return {
    FormSheet: ({
      children,
      onClose,
      onSubmit,
    }: {
      children: React.ReactNode;
      onClose: () => void;
      onSubmit: () => void;
    }) => (
      <View>
        {children}
        <Button title="Close" onPress={onClose} />
        <Button title="Save" onPress={onSubmit} />
      </View>
    ),
  };
});

beforeAll(async () => {
  await createInstance().use(initReactI18next).init({
    lng: 'en',
    defaultNS: 'android',
    resources: { en },
  });
});
beforeEach(() => jest.clearAllMocks());
it('preserves dirty fields until discard is explicitly confirmed', () => {
  const close = jest.fn();
  const screen = render(
    <AddSnippetSheet visible onClose={close} onSubmit={jest.fn()} existingTriggers={[]} />,
  );
  fireEvent.changeText(screen.getByLabelText('Trigger'), 'signoff');
  fireEvent.press(screen.getByText('Close'));
  expect(close).not.toHaveBeenCalled();
  expect(screen.getByLabelText('Trigger').props.value).toBe('signoff');
  expect(confirmDestructive).toHaveBeenCalledWith('Discard changes?', expect.any(String), close, {
    destructiveLabel: 'Discard',
    cancelLabel: 'Cancel',
  });
  (confirmDestructive as jest.Mock).mock.calls[0][2]();
  expect(close).toHaveBeenCalledTimes(1);
});

it('closes unchanged edits and successfully saved edits without a discard prompt', () => {
  const close = jest.fn();
  const save = jest.fn();
  const screen = render(
    <AddSnippetSheet
      visible
      initial={{ trigger: 'signoff', replacement: 'Thanks' }}
      onClose={close}
      onSubmit={save}
      existingTriggers={[]}
    />,
  );
  fireEvent.press(screen.getByText('Close'));
  expect(close).toHaveBeenCalledTimes(1);
  fireEvent.changeText(screen.getByLabelText('Replacement'), 'Thank you');
  fireEvent.press(screen.getByText('Save'));
  expect(save).toHaveBeenCalledWith('signoff', 'Thank you');
  expect(close).toHaveBeenCalledTimes(2);
  expect(confirmDestructive).not.toHaveBeenCalled();
});

describe('Android keyboard navigation', () => {
  const originalPlatform = Platform.OS;

  beforeEach(() => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
    jest.useFakeTimers();
  });

  afterEach(() => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform });
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('moves Next to the replacement without saving or losing multiline text', () => {
    const focus = jest.spyOn(TextInput.prototype, 'focus');
    const save = jest.fn();
    const close = jest.fn();
    const screen = render(
      <AddSnippetSheet
        visible
        initial={{ trigger: 'مراجعة', replacement: 'الأربعاء 10:30\nBring three files.' }}
        onClose={close}
        onSubmit={save}
        existingTriggers={[]}
      />,
    );
    act(() => jest.advanceTimersByTime(120));
    focus.mockClear();

    fireEvent(screen.getByLabelText('Trigger'), 'submitEditing', {
      nativeEvent: { text: 'مراجعة' },
    });

    expect(focus).toHaveBeenCalledTimes(1);
    expect(focus.mock.contexts[0].props.accessibilityLabel).toBe('Replacement');
    expect(screen.getByLabelText('Trigger').props.submitBehavior).toBe('submit');
    expect(screen.getByLabelText('Replacement').props.value).toBe(
      'الأربعاء 10:30\nBring three files.',
    );
    expect(save).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });
});
