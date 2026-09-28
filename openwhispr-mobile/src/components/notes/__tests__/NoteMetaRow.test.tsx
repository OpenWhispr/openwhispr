import { fireEvent, render } from '@testing-library/react-native';
import type { CalendarParticipant } from '@/data/calendarTypes';
import { NoteMetaRow } from '../NoteMetaRow';
import { AttendeesSheet } from '../AttendeesSheet';

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

const person = (overrides: Partial<CalendarParticipant> = {}): CalendarParticipant => ({
  email: null,
  displayName: null,
  responseStatus: 'accepted',
  optional: false,
  organizer: false,
  resource: false,
  self: false,
  ...overrides,
});

describe('NoteMetaRow', () => {
  const props = {
    dateLabel: 'Today 09:27',
    attendeeLabel: 'Sam +3',
    folderLabel: 'Meetings',
    onPressAttendees: jest.fn(),
    onPressFolder: jest.fn(),
  };

  it('shows the date, attendees and folder', () => {
    const { getByText } = render(<NoteMetaRow {...props} />);
    expect(getByText('Today 09:27')).toBeTruthy();
    expect(getByText('Sam +3')).toBeTruthy();
    expect(getByText('Meetings')).toBeTruthy();
  });

  it('opens the attendees and the folder picker', () => {
    const onPressAttendees = jest.fn();
    const onPressFolder = jest.fn();
    const { getByTestId } = render(
      <NoteMetaRow {...props} onPressAttendees={onPressAttendees} onPressFolder={onPressFolder} />,
    );
    fireEvent.press(getByTestId('note-meta-attendees'));
    fireEvent.press(getByTestId('note-meta-folder'));
    expect(onPressAttendees).toHaveBeenCalled();
    expect(onPressFolder).toHaveBeenCalled();
  });

  it('hides the attendees chip when nobody attends', () => {
    const { queryByTestId, getByText } = render(<NoteMetaRow {...props} attendeeLabel={null} />);
    expect(queryByTestId('note-meta-attendees')).toBeNull();
    expect(getByText('Today 09:27')).toBeTruthy();
  });

  it('keeps long names to one line', () => {
    const { getByText } = render(
      <NoteMetaRow
        {...props}
        attendeeLabel="Bartholomew-Alexander +12"
        folderLabel="Quarterly planning and roadmap reviews"
      />,
    );
    expect(getByText('Bartholomew-Alexander +12').props).toMatchObject({
      numberOfLines: 1,
      ellipsizeMode: 'middle',
    });
    expect(getByText('Quarterly planning and roadmap reviews').props.numberOfLines).toBe(1);
  });

  it('hides the folder chip for a note that cannot be moved', () => {
    const { queryByTestId } = render(<NoteMetaRow {...props} onPressFolder={undefined} />);
    expect(queryByTestId('note-meta-folder')).toBeNull();
  });

  it('offers Add to folder for a note outside any folder', () => {
    const { getByText } = render(<NoteMetaRow {...props} folderLabel={null} />);
    expect(getByText('Add to folder')).toBeTruthy();
  });
});

describe('AttendeesSheet', () => {
  it('lists people with the organizer first, marks the organizer and you, and skips rooms', () => {
    const { getByText, queryByText, getAllByTestId } = render(
      <AttendeesSheet
        visible
        onClose={jest.fn()}
        participants={[
          person({ displayName: 'Sam Lee', email: 'sam@x.com' }),
          person({ displayName: 'Board Room', resource: true }),
          person({ displayName: 'Me', email: 'me@x.com', self: true }),
          person({ displayName: 'Ana Ruiz', email: 'ana@x.com', organizer: true }),
        ]}
      />,
    );
    expect(getByText('Attendees')).toBeTruthy();
    expect(getAllByTestId(/^attendee-row-/).map((row) => row.props.testID)).toEqual([
      'attendee-row-0',
      'attendee-row-1',
      'attendee-row-2',
    ]);
    expect(getByText('Ana Ruiz')).toBeTruthy();
    expect(getByText('Organizer')).toBeTruthy();
    expect(getByText('You')).toBeTruthy();
    expect(getByText('sam@x.com')).toBeTruthy();
    expect(queryByText('Board Room')).toBeNull();
  });

  it('closes from the close button', () => {
    const onClose = jest.fn();
    const { getByLabelText } = render(
      <AttendeesSheet visible onClose={onClose} participants={[person({ displayName: 'Sam' })]} />,
    );
    fireEvent.press(getByLabelText('Close'));
    expect(onClose).toHaveBeenCalled();
  });
});
