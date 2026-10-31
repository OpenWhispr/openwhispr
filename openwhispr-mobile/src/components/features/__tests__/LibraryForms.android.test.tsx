import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import { Alert, Platform, Pressable, StyleSheet } from 'react-native';
import { cssInterop } from 'react-native-css-interop/dist/runtime/native/api';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import en from '@/locales/en/translation.json';
import ar from '@/locales/ar/translation.json';
import de from '@/locales/de/translation.json';
import { AddSnippetSheet } from '../AddSnippetSheet';
import { AddWordsSheet } from '../AddWordsSheet';

// Use the native className adapter rather than Jest's default web resolution.
// Otherwise Pressable style callbacks appear to work here but disappear on Android.
jest.mock('react-native-css-interop/dist/runtime/api', () =>
  jest.requireActual('react-native-css-interop/dist/runtime/native/api'),
);
jest.mock('@/lib/utils', () => ({ safeHaptics: jest.fn() }));
jest.mock('@/lib/fonts', () => ({ AppFont: {} }));
jest.mock('@/config/colors', () => ({ iosColor: () => '#000' }));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('@/components/ui/FormSheet', () => {
  const { View, Text, Button } = require('react-native');
  return {
    FormSheet: ({
      children,
      title,
      submitLabel,
      canSubmit,
      onClose,
      onSubmit,
      destructiveAction,
    }: any) => (
      <View>
        <Text>{title}</Text>
        {children}
        <Button title="test close" onPress={onClose} />
        <Button title={submitLabel} disabled={!canSubmit} onPress={onSubmit} />
        {destructiveAction && (
          <Button title={destructiveAction.label} onPress={destructiveAction.onPress} />
        )}
      </View>
    ),
  };
});

const originalOS = Platform.OS;
beforeEach(() => {
  Platform.OS = 'android';
  cssInterop(Pressable, { className: 'style' });
});
afterEach(() => {
  Platform.OS = originalOS;
  jest.restoreAllMocks();
});
async function language(lng: string) {
  const i18n = createInstance();
  await i18n.init({
    lng,
    fallbackLng: 'en',
    defaultNS: 'android',
    resources: { en, ar, de },
    interpolation: { escapeValue: false },
  });
  return i18n;
}

it('changes mounted form language without translating or losing user input; rejects duplicate triggers', async () => {
  const i18n = await language('en');
  const save = jest.fn();
  const screen = render(
    <I18nextProvider i18n={i18n}>
      <AddSnippetSheet visible onClose={jest.fn()} onSubmit={save} existingTriggers={['signoff']} />
    </I18nextProvider>,
  );
  fireEvent.changeText(screen.getByLabelText('Trigger'), 'signoff');
  fireEvent.changeText(screen.getByLabelText('Replacement'), 'Thanks, Jo');
  await act(async () => {
    await i18n.changeLanguage('ar');
  });
  expect(screen.getByText(ar.android.library.duplicateTrigger)).toBeTruthy();
  expect(screen.getByLabelText(ar.android.library.trigger).props.value).toBe('signoff');
  expect(screen.getByLabelText(ar.android.library.replacement).props.value).toBe('Thanks, Jo');
  fireEvent.press(screen.getByText(ar.android.library.add));
  expect(save).not.toHaveBeenCalled();
  fireEvent.changeText(screen.getByLabelText(ar.android.library.trigger), 'review sign off');
  fireEvent.press(screen.getByText(ar.android.library.add));
  expect(save).toHaveBeenCalledWith('review sign off', 'Thanks, Jo');
});

it('localizes both destructive confirmation buttons and only deletes after confirmation', async () => {
  const i18n = await language('ar');
  const alert = jest.spyOn(Alert, 'alert');
  const remove = jest.fn();
  const close = jest.fn();
  const screen = render(
    <I18nextProvider i18n={i18n}>
      <AddSnippetSheet
        visible
        initial={{ trigger: 'My signoff', replacement: 'Jo' }}
        onClose={close}
        onSubmit={jest.fn()}
        onDelete={remove}
        existingTriggers={[]}
      />
    </I18nextProvider>,
  );
  fireEvent.press(screen.getByText(ar.android.library.deleteSnippet));
  expect(remove).not.toHaveBeenCalled();
  expect(alert).toHaveBeenCalledWith(
    ar.android.library.deleteSnippet,
    'سيتم حذف «My signoff».',
    expect.any(Array),
  );
  const buttons = alert.mock.calls[0][2]!;
  expect(buttons.map((b) => b.text)).toEqual([ar.android.cancel, ar.android.deleteAction]);
  buttons[1].onPress?.();
  expect(remove).toHaveBeenCalledTimes(1);
  expect(close).toHaveBeenCalledTimes(1);
});

it('removes only the chosen dictionary segment after a language change and saves exact remaining text', async () => {
  const i18n = await language('de');
  const save = jest.fn();
  const screen = render(
    <I18nextProvider i18n={i18n}>
      <AddWordsSheet visible onClose={jest.fn()} onSubmit={save} />
    </I18nextProvider>,
  );
  fireEvent.changeText(
    screen.getByPlaceholderText(de.android.library.wordPlaceholder),
    'Synty,, Jo, Synty',
  );
  await act(async () => {
    await i18n.changeLanguage('ar');
  });
  fireEvent.press(screen.getByLabelText('إزالة Jo'));
  const input = screen.getByPlaceholderText(ar.android.library.wordPlaceholder);
  expect(input.props.value).toBe('Synty,, Synty');
  fireEvent.press(screen.getByText('إضافة كلمات (2)'));
  expect(save).toHaveBeenCalledWith('Synty,, Synty');
});

it('keeps the existing English iOS form even with an Arabic provider', async () => {
  Platform.OS = 'ios';
  const i18n = await language('ar');
  const screen = render(
    <I18nextProvider i18n={i18n}>
      <AddSnippetSheet visible onClose={jest.fn()} onSubmit={jest.fn()} existingTriggers={[]} />
    </I18nextProvider>,
  );
  expect(screen.getByLabelText('Trigger')).toBeTruthy();
  expect(screen.getByText('Add snippet')).toBeTruthy();
});

it('preserves dictionary chip bounds and context tint through native className interop', async () => {
  const i18n = await language('en');
  const save = jest.fn();
  const screen = render(
    <I18nextProvider i18n={i18n}>
      <AddWordsSheet visible onClose={jest.fn()} onSubmit={save} />
    </I18nextProvider>,
  );
  const longWord = 'Pneumonoultramicroscopicsilicovolcanoconiosis';
  const phrase = 'The word is SyntheticAcceptance279';
  fireEvent.changeText(screen.getByLabelText('Add words'), `${longWord}, ${phrase}`);

  for (const entry of [longWord, phrase]) {
    const chip = screen.getByRole('button', { name: `Remove ${entry}` });
    const style = StyleSheet.flatten(chip.props.style);
    expect(style.maxWidth).toBe('100%');
    expect(style.minWidth).toBeGreaterThanOrEqual(48);
    expect(style.minHeight).toBeGreaterThanOrEqual(48);
  }
  const contextChip = screen.getByRole('button', { name: `Remove ${phrase}` });
  expect(StyleSheet.flatten(contextChip.props.style).backgroundColor).toBe('rgba(0,122,255,0.12)');

  fireEvent.press(contextChip);
  expect(screen.getByLabelText('Add words').props.value).toBe(longWord);
  expect(screen.queryByRole('button', { name: `Remove ${phrase}` })).toBeNull();
  expect(save).not.toHaveBeenCalled();
});
