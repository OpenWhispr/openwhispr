// The Android snippet sheet is now Dictionary's own (src/android/dictionary/sheets.tsx).
import React from 'react';
import { Platform } from 'react-native';
import { fireEvent, render } from '@testing-library/react-native';
import { createInstance } from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from '@/locales/en/translation.json';
import { AddSnippetSheet } from '@/components/features/AddSnippetSheet';
import { confirmDestructive } from '@/lib/alerts';

jest.mock('@/lib/alerts', () => ({ confirmDestructive: jest.fn() }));
jest.mock('@/android/lib/alerts', () => jest.requireMock('@/lib/alerts'));
jest.mock('@/lib/utils', () => ({ safeHaptics: jest.fn() }));
jest.mock('@/android/shared/lib/utils', () => jest.requireMock('@/lib/utils'));
jest.mock('@/lib/fonts', () => ({ AppFont: {} }));
jest.mock('@/android/shared/lib/fonts', () => jest.requireMock('@/lib/fonts'));
jest.mock('@/config/colors', () => ({ iosColor: () => '#000' }));
jest.mock('@/android/shared/config/colors', () => jest.requireMock('@/config/colors'));
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
const originalSheetPlatform = Platform.OS;
beforeEach(() => {
  jest.clearAllMocks();
  Platform.OS = originalSheetPlatform;
});
afterEach(() => {
  Platform.OS = originalSheetPlatform;
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
  fireEvent.press(screen.getByText(/^close$/i));
  expect(close).toHaveBeenCalledTimes(1);
  fireEvent.changeText(screen.getByPlaceholderText('e.g. Best regards, Alex'), 'Thank you');
  fireEvent.press(screen.getByText('Save'));
  expect(save).toHaveBeenCalledWith('signoff', 'Thank you');
  expect(close).toHaveBeenCalledTimes(2);
  expect(confirmDestructive).not.toHaveBeenCalled();
});

it('preserves upstream iOS closing without a dirty-field confirmation', () => {
  Platform.OS = 'ios';
  const close = jest.fn();
  const screen = render(
    <AddSnippetSheet visible onClose={close} onSubmit={jest.fn()} existingTriggers={[]} />,
  );
  fireEvent.changeText(screen.getByPlaceholderText('e.g. signoff'), 'signoff');
  fireEvent.press(screen.getByText(/^close$/i));
  expect(close).toHaveBeenCalledTimes(1);
  expect(confirmDestructive).not.toHaveBeenCalled();
});
