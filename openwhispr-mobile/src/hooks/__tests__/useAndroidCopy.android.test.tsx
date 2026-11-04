import React from 'react';
import { act, renderHook } from '@testing-library/react-native';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import en from '@/locales/en/translation.json';
import ar from '@/locales/ar/translation.json';
import { useAndroidCopy } from '../useAndroidCopy.android';

async function fixture() {
  const i18n = createInstance();
  await i18n.init({
    lng: 'en',
    fallbackLng: 'en',
    defaultNS: 'android',
    resources: { en, ar },
    interpolation: { escapeValue: false },
  });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <I18nextProvider i18n={i18n}>{children}</I18nextProvider>
  );
  return { i18n, wrapper };
}

it('updates mounted copy when the Android app language changes', async () => {
  const { i18n, wrapper } = await fixture();
  const { result, rerender } = renderHook(() => useAndroidCopy(), { wrapper });
  const firstCopy = result.current.copy;
  expect(firstCopy('library.today', 'Wrong fallback')).toBe('Today');
  rerender({});
  expect(result.current.copy).toBe(firstCopy);
  await act(async () => {
    await i18n.changeLanguage('ar');
  });
  expect(result.current.language).toBe('ar');
  expect(result.current.copy('library.today', 'Wrong fallback')).toBe('اليوم');
});

it('keeps interpolation and gives the supplied fallback precedence over option defaults', async () => {
  const { wrapper } = await fixture();
  const { result } = renderHook(() => useAndroidCopy(), { wrapper });
  const options = Object.freeze({ name: 'Noor & <text>', defaultValue: 'Wrong default' });
  expect(result.current.copy('fixture.missing', 'Hello {{name}}', options)).toBe(
    'Hello Noor & <text>',
  );
  expect(result.current.copy('fixture.missing', '', options)).toBe('');
  expect(result.current.copy('library.today', 'Wrong fallback', { lng: 'ar' })).toBe('اليوم');
  expect(options).toEqual({ name: 'Noor & <text>', defaultValue: 'Wrong default' });
});
