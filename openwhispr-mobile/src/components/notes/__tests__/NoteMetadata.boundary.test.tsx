import { cleanupAsync, fireEvent, render } from '@testing-library/react-native';
import type { CalendarParticipant } from '@/data/calendarTypes';

jest.mock('@/hooks/useAndroidCopy', () => {
  throw new Error('Android copy reached default note metadata');
});
jest.mock('react-i18next', () => {
  throw new Error('Android translation reached default note metadata');
});
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('@/components/ui/GlassIconButton', () => ({
  GlassIconButton: require('react-native').Pressable,
}));

afterEach(async () => {
  await cleanupAsync();
});

it('keeps default metadata actions without Android translation', () => {
  const { NoteMetaRow } = jest.requireActual('../NoteMetaRow');
  const open = jest.fn();
  const screen = render(
    <NoteMetaRow
      dateLabel="Literal date"
      attendeeLabel="Sam +2"
      folderLabel={null}
      onPressAttendees={open}
      onPressFolder={jest.fn()}
    />,
  );
  fireEvent.press(screen.getByLabelText('Attendees: Sam +2'));
  expect(open).toHaveBeenCalledTimes(1);
  expect(screen.getByLabelText('Add to folder')).toBeTruthy();
});

it('keeps default attendee roles and close callback without Android translation', () => {
  const { AttendeesSheet } = jest.requireActual('../AttendeesSheet');
  const close = jest.fn();
  const participants = [
    { email: 'fixture@example.invalid', displayName: 'Literal Name', self: true, organizer: true },
  ] as CalendarParticipant[];
  const screen = render(<AttendeesSheet visible participants={participants} onClose={close} />);
  expect(screen.getByText('You')).toBeTruthy();
  expect(screen.getByText('Organizer')).toBeTruthy();
  expect(screen.getByText('fixture@example.invalid')).toBeTruthy();
  fireEvent.press(screen.getByLabelText('Close'));
  expect(close).toHaveBeenCalledTimes(1);
});
