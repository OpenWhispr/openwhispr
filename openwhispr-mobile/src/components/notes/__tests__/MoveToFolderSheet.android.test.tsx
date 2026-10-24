import { act, fireEvent, render } from '@testing-library/react-native';
import { Platform } from 'react-native';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import en from '@/locales/en/translation.json';
import ar from '@/locales/ar/translation.json';
import type { Folder } from '@/data';
import { MoveToFolderSheet } from '../MoveToFolderSheet';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('@/components/ui/GlassIconButton', () => ({
  GlassIconButton: ({
    children,
    onPress,
    accessibilityLabel,
  }: {
    children?: React.ReactNode;
    onPress?: () => void;
    accessibilityLabel?: string;
  }) => {
    const { Pressable } = require('react-native');
    return (
      <Pressable accessibilityLabel={accessibilityLabel} onPress={onPress}>
        {children}
      </Pressable>
    );
  },
}));

const originalOS = Platform.OS;
afterEach(() => {
  Platform.OS = originalOS;
});

it('keeps destination IDs, excludes current/deleted folders, and preserves a typed name on language change', async () => {
  Platform.OS = 'android';
  const i18n = createInstance();
  await i18n.init({
    lng: 'en',
    defaultNS: 'android',
    resources: { en, ar },
    interpolation: { escapeValue: false },
  });
  const pick = jest.fn();
  const create = jest.fn();
  const close = jest.fn();
  const screen = render(
    <I18nextProvider i18n={i18n}>
      <MoveToFolderSheet
        visible
        folders={
          [
            { id: 1, name: 'Current', deletedAt: null },
            { id: 2, name: 'Research & Jo', deletedAt: null },
            { id: 3, name: 'Deleted', deletedAt: '2026-01-01' },
          ] as Folder[]
        }
        folderCounts={{ 2: 3 }}
        excludeFolderId={1}
        onClose={close}
        onPickFolder={pick}
        onCreateAndPick={create}
      />
    </I18nextProvider>,
  );
  expect(screen.queryByText('Current')).toBeNull();
  expect(screen.queryByText('Deleted')).toBeNull();
  fireEvent.press(screen.getByText('Research & Jo'));
  expect(pick).toHaveBeenCalledWith(2);
  fireEvent.press(screen.getByLabelText(en.android.createFolder));
  fireEvent.changeText(screen.getByLabelText(en.android.folderName), '  Atlas & Jo  ');
  await act(async () => {
    await i18n.changeLanguage('ar');
  });
  expect(screen.getByText(ar.android.library.moveToFolder)).toBeTruthy();
  expect(screen.getByDisplayValue('  Atlas & Jo  ')).toBeTruthy();
  fireEvent.press(screen.getByText(ar.android.cancel));
  expect(create).not.toHaveBeenCalled();
  fireEvent.press(screen.getByLabelText(ar.android.createFolder));
  expect(screen.getByDisplayValue('  Atlas & Jo  ')).toBeTruthy();
  fireEvent.press(screen.getByText(ar.android.createFolder));
  expect(create).toHaveBeenCalledWith('Atlas & Jo');
  fireEvent.press(screen.getByLabelText(ar.android.close));
  expect(close).toHaveBeenCalledTimes(1);
});

it('keeps the existing iOS move-sheet copy even with Arabic selected', async () => {
  Platform.OS = 'ios';
  const i18n = createInstance();
  await i18n.init({ lng: 'ar', defaultNS: 'android', resources: { en, ar } });
  const screen = render(
    <I18nextProvider i18n={i18n}>
      <MoveToFolderSheet
        visible
        folders={[]}
        folderCounts={{}}
        excludeFolderId={null}
        onClose={jest.fn()}
        onPickFolder={jest.fn()}
        onCreateAndPick={jest.fn()}
      />
    </I18nextProvider>,
  );
  expect(screen.getByText('Move to Folder')).toBeTruthy();
  expect(screen.getByText('Create New Folder')).toBeTruthy();
  expect(screen.getByLabelText('Close')).toBeTruthy();
});
