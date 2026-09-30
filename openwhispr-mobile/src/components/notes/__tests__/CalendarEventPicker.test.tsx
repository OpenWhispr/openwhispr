import { fireEvent, render } from '@testing-library/react-native';
import type { GoogleCalendarAccount, GoogleCalendarEvent } from '@/data/calendarTypes';
import { CalendarEventPicker } from '../CalendarEventPicker';

jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));

const account = (overrides: Partial<GoogleCalendarAccount> = {}): GoogleCalendarAccount =>
  ({
    id: 1,
    googleSubject: 'google-sub-1',
    email: 'person@example.com',
    displayName: 'Person Example',
    grantedScopes: 'openid email calendar',
    status: 'connected',
    lastSyncAt: null,
    lastError: null,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  }) as GoogleCalendarAccount;

const event = (overrides: Partial<GoogleCalendarEvent> = {}): GoogleCalendarEvent =>
  ({
    id: 30,
    accountId: 1,
    calendarLocalId: 10,
    googleCalendarId: 'primary',
    googleEventId: 'event-1',
    iCalUID: null,
    summary: 'Weekly Planning',
    description: null,
    location: null,
    startAt: '2026-06-24T10:00:00.000Z',
    endAt: '2026-06-24T11:00:00.000Z',
    allDay: 0,
    status: 'confirmed',
    organizerEmail: null,
    creatorEmail: null,
    attendeesJson: null,
    updated: null,
    htmlLink: null,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  }) as GoogleCalendarEvent;

describe('CalendarEventPicker', () => {
  it('defaults to No event and reports event/no-event selections', () => {
    const onSelect = jest.fn();
    const accountsById = new Map([[1, account()]]);
    const events = [event()];
    const { getByTestId, rerender } = render(
      <CalendarEventPicker
        events={events}
        selectedEventId={null}
        accountsById={accountsById}
        onSelect={onSelect}
      />,
    );

    expect(getByTestId('calendar-event-none').props.accessibilityState.selected).toBe(true);
    fireEvent.press(getByTestId('calendar-event-30'));
    expect(onSelect).toHaveBeenCalledWith(30);

    rerender(
      <CalendarEventPicker
        events={events}
        selectedEventId={30}
        accountsById={accountsById}
        onSelect={onSelect}
      />,
    );

    expect(getByTestId('calendar-event-30').props.accessibilityState.selected).toBe(true);
    fireEvent.press(getByTestId('calendar-event-none'));
    expect(onSelect).toHaveBeenLastCalledWith(null);
  });
});
