import { act, fireEvent, render } from '@testing-library/react-native';
import { Platform } from 'react-native';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import en from '@/locales/en/translation.json';
import ar from '@/locales/ar/translation.json';
import { SpacesSection } from '../SpacesSection';
import { FolderRow } from '../FolderRow';
import type { Space } from '@/data';

jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('../SectionHeader', () => ({
  SectionHeader: ({ label }: { label: string }) =>
    require('react').createElement(require('react-native').Text, null, label),
}));
const originalOS = Platform.OS;
afterEach(() => {
  Platform.OS = originalOS;
});

it('updates fallback headings and count labels while preserving user names and destinations', async () => {
  Platform.OS = 'android';
  const i18n = createInstance();
  await i18n.init({
    lng: 'en',
    defaultNS: 'android',
    resources: { en, ar },
    interpolation: { escapeValue: false },
  });
  const select = jest.fn();
  const openFolder = jest.fn();
  const spaces = [
    { id: 7, name: 'Design & Jo', workspaceId: 'w1', workspaceName: null, memberCount: 3 },
    { id: 8, name: 'Research', workspaceId: 'w2', workspaceName: 'Studio & Co', memberCount: 1 },
  ] as Space[];
  const screen = render(
    <I18nextProvider i18n={i18n}>
      <SpacesSection spaces={spaces} onSelect={select} />
      <FolderRow
        sfName="folder"
        mdName="Folder"
        label="My research"
        count={2}
        onPress={openFolder}
      />
    </I18nextProvider>,
  );
  expect(screen.getByText('Spaces')).toBeTruthy();
  await act(async () => {
    await i18n.changeLanguage('ar');
  });
  expect(screen.queryByText('Spaces')).toBeNull();
  expect(screen.getByText(ar.android.library.spaces)).toBeTruthy();
  expect(screen.getByText('Studio & Co')).toBeTruthy();
  fireEvent.press(screen.getByLabelText('Design & Jo, الأعضاء: 3'));
  expect(select).toHaveBeenCalledWith(7);
  fireEvent.press(screen.getByLabelText('My research, الملاحظات: 2'));
  expect(openFolder).toHaveBeenCalledTimes(1);
});
