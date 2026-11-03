import { fireEvent, render } from '@testing-library/react-native';
import { Platform } from 'react-native';
import { NoteRow } from '../NoteRow';
import type { Note } from '@/data';

jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('@/components/ui/SwipeableCard', () => ({
  SwipeableCard: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('lucide-react-native', () => ({ CloudOff: () => null }));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { resolvedLanguage: 'ar' },
    t: (key: string, options: { defaultValue: string }) =>
      ({ moveAction: 'نقل', deleteAction: 'حذف' })[key] ?? options.defaultValue,
  }),
}));
const originalOS = Platform.OS;
afterEach(() => {
  Platform.OS = originalOS;
});
const note = {
  id: 46,
  title: 'My original title',
  content: 'Keep these words',
  updatedAt: '2026-10-16T12:00:00Z',
  isPrivate: 1,
} as Note;

it('exposes localized move/delete actions on the accessible row and dispatches only the selected action', () => {
  Platform.OS = 'android';
  const move = jest.fn();
  const remove = jest.fn();
  const open = jest.fn();
  const view = render(
    <NoteRow note={note} bucket="today" onPress={open} onDelete={remove} onMove={move} />,
  );
  const row = view.getByRole('button', { name: /My original title/ });
  expect(row.props.accessibilityActions).toEqual([
    { name: 'move', label: 'نقل' },
    { name: 'delete', label: 'حذف' },
  ]);
  fireEvent(row, 'accessibilityAction', { nativeEvent: { actionName: 'move' } });
  expect(move).toHaveBeenCalledTimes(1);
  expect(remove).not.toHaveBeenCalled();
  fireEvent(row, 'accessibilityAction', { nativeEvent: { actionName: 'delete' } });
  expect(remove).toHaveBeenCalledTimes(1);
  expect(open).not.toHaveBeenCalled();
  fireEvent(row, 'accessibilityAction', { nativeEvent: { actionName: 'unknown' } });
  expect(remove).toHaveBeenCalledTimes(1);
  expect(move).toHaveBeenCalledTimes(1);
  fireEvent.press(row);
  expect(open).toHaveBeenCalledTimes(1);
});

it('does not offer a missing move destination', () => {
  Platform.OS = 'android';
  const view = render(
    <NoteRow note={note} bucket="today" onPress={jest.fn()} onDelete={jest.fn()} />,
  );
  expect(view.getByRole('button').props.accessibilityActions).toEqual([
    { name: 'delete', label: 'حذف' },
  ]);
});

it('leaves existing iOS accessibility behavior unchanged', () => {
  Platform.OS = 'ios';
  const view = render(
    <NoteRow
      note={note}
      bucket="today"
      onPress={jest.fn()}
      onDelete={jest.fn()}
      onMove={jest.fn()}
    />,
  );
  expect(view.getByRole('button').props.accessibilityActions).toBeUndefined();
  expect(view.getByRole('button').props.onAccessibilityAction).toBeUndefined();
});
