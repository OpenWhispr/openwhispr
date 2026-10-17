import { act, render, screen } from '@testing-library/react-native';
import { AppState, AppStateStatus, Text } from 'react-native';
import { useTranslation } from 'react-i18next';
import i18n, { observeAndroidLanguage } from '../strings';

let mockLocale = 'en-US';
jest.mock('../../../modules/android-dictation/src', () => ({
  AndroidDictation: { getLocale: () => mockLocale },
}));

function Translation() {
  const { t } = useTranslation();
  return <Text>{t('close')}</Text>;
}

let listener: (state: AppStateStatus) => void;
let stop: () => void;
const remove = jest.fn();
beforeEach(async () => {
  mockLocale = 'en-US';
  await i18n.changeLanguage('en');
  remove.mockClear();
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, callback) => {
    listener = callback;
    return { remove };
  });
});
afterEach(() => {
  stop?.();
  jest.restoreAllMocks();
});

it('updates a mounted screen after returning from Android language settings', async () => {
  stop = observeAndroidLanguage();
  render(<Translation />);
  expect(screen.getByText('Close')).toBeTruthy();
  mockLocale = 'de-DE';
  act(() => listener('background'));
  expect(screen.getByText('Close')).toBeTruthy();
  await act(async () => listener('active'));
  expect(screen.getByText('Schließen')).toBeTruthy();
  mockLocale = 'en-US';
  await act(async () => listener('active'));
  expect(screen.getByText('Close')).toBeTruthy();
});

it('refreshes when an activity remounts with an already-initialized JS runtime', () => {
  mockLocale = 'fr-FR';
  stop = observeAndroidLanguage();
  render(<Translation />);
  expect(screen.getByText('Fermer')).toBeTruthy();
  stop();
  expect(remove).toHaveBeenCalledTimes(1);
});

it.each([
  ['zh-Hant-TW', 'zh-TW'],
  ['zh_Hans_CN', 'zh-CN'],
  ['ar-EG', 'ar'],
  ['nl-NL', 'en'],
])('resolves Android locale %s to the bundled %s translation', (locale, expected) => {
  mockLocale = locale;
  stop = observeAndroidLanguage();
  expect(i18n.language).toBe(expected);
});
