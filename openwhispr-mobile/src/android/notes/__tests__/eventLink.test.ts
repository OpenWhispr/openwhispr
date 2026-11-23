import type { GoogleCalendarAccount, GoogleCalendarEvent } from '@/data/calendarTypes';
import { fetchConferenceLink } from '../eventLink';

jest.mock('@/services/calendar/googleCalendarAuth', () => ({
  hasRequiredGoogleCalendarScopes: () => true,
  refreshStoredGoogleCalendarToken: async () => ({ accessToken: 'token' }),
}));
jest.mock('@/services/calendar/googleCalendarConfig', () => ({
  getGoogleCalendarClientId: () => 'client',
}));

const account = { googleSubject: 'sub', grantedScopes: 'calendar' } as GoogleCalendarAccount;
const event = (id: string) =>
  ({ accountId: 1, googleCalendarId: 'primary', googleEventId: id }) as GoogleCalendarEvent;
const reply = (body: object, ok = true) =>
  jest.fn(async () => ({ ok, json: async () => body })) as unknown as typeof fetch;

describe('fetchConferenceLink', () => {
  it('reads the Meet link Google keeps outside the description', async () => {
    const http = reply({ hangoutLink: 'https://meet.google.com/abc-defg-hij' });
    await expect(fetchConferenceLink(event('a'), account, http)).resolves.toBe(
      'https://meet.google.com/abc-defg-hij',
    );
    expect(jest.mocked(http).mock.calls[0][0]).toContain('/calendars/primary/events/a?fields=');
  });

  it('falls back to the video entry point (Zoom, Teams add-ons)', async () => {
    const http = reply({
      conferenceData: {
        entryPoints: [
          { entryPointType: 'phone', uri: 'tel:+1' },
          { entryPointType: 'video', uri: 'https://zoom.us/j/1' },
        ],
      },
    });
    await expect(fetchConferenceLink(event('b'), account, http)).resolves.toBe(
      'https://zoom.us/j/1',
    );
  });

  it('gives no Join for a failed request, a non-https link or no account', async () => {
    await expect(fetchConferenceLink(event('c'), account, reply({}, false))).resolves.toBeNull();
    await expect(
      fetchConferenceLink(event('d'), account, reply({ hangoutLink: 'javascript:alert(1)' })),
    ).resolves.toBeNull();
    await expect(fetchConferenceLink(event('e'), null, reply({}))).resolves.toBeNull();
  });
});
