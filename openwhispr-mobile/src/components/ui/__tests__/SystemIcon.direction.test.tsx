import React from 'react';
import { act, render } from '@testing-library/react-native';
import { I18nManager } from 'react-native';
import { createInstance } from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { AndroidSystemIcon as SystemIcon } from '../SystemIcon';

jest.mock('lucide-react-native', () => {
  const Text = require('react-native').Text;
  return Object.fromEntries(
    ['ArrowLeft', 'ArrowRight', 'ChevronLeft', 'ChevronRight', 'Mic'].map((name) => [
      name,
      () => <Text>{name}</Text>,
    ]),
  );
});
jest.mock('@/config/colors', () => ({ BRAND: '#2457C5', iosColor: () => '#111' }));

it.each([
  ['ArrowLeft', 'ArrowRight'],
  ['ChevronRight', 'ChevronLeft'],
  ['Mic', 'Mic'],
] as const)(
  'updates mounted %s when app language changes despite cached native direction',
  async (icon, expected) => {
    const original = I18nManager.isRTL;
    const i18n = createInstance();
    await i18n.use(initReactI18next).init({
      lng: 'en',
      resources: { en: { translation: {} }, ar: { translation: {} } },
      interpolation: { escapeValue: false },
    });
    try {
      I18nManager.isRTL = false;
      const view = render(
        <I18nextProvider i18n={i18n}>
          <SystemIcon name="test" mdName={icon} />
        </I18nextProvider>,
      );
      expect(view.getByText(icon)).toBeTruthy();
      await act(async () => {
        await i18n.changeLanguage('ar');
      });
      expect(view.getByText(expected)).toBeTruthy();
      // Returning to LTR must also ignore a native value cached at an Arabic startup.
      I18nManager.isRTL = true;
      await act(async () => {
        await i18n.changeLanguage('en');
      });
      expect(view.getByText(icon)).toBeTruthy();
    } finally {
      I18nManager.isRTL = original;
    }
  },
);
