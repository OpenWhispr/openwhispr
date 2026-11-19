jest.mock('@/components/ui/Text', () => ({ Text: 'Text' }));
jest.mock('../kit', () => ({ relativeTime: () => '2 min ago' }));
jest.mock('../../home/kit', () => ({ type: { footnote: {} } }));
jest.mock('../look', () => ({ edgeCard: {} }));
jest.mock('../../calendar/connect', () => ({
  needsReconnect: (account: { status: string }) => account.status === 'needs_reconnect',
}));

import { accountName, accountSummary, sortAccounts } from '../calendarParts';

const t = ((key: string, options?: Record<string, unknown>) =>
  options ? `${key}:${JSON.stringify(options)}` : key) as never;
const account = (id: number, status = 'connected', fields: object = {}) =>
  ({ id, status, email: `a${id}@x.com`, lastSyncAt: '2026-11-19T10:00:00Z', ...fields }) as never;
const calendar = (selected: number) => ({ selected }) as never;

it('20.2: signed-out accounts sort first, the rest keep their order', () => {
  const sorted = sortAccounts([account(1), account(2, 'needs_reconnect'), account(3)]);
  expect(sorted.map((a: { id: number }) => a.id)).toEqual([2, 1, 3]);
});

it('20.2: says how many calendars are on and when it synced', () => {
  expect(accountSummary(account(1), [calendar(1), calendar(0)], t)).toBe(
    'calendarsOn:{"on":1,"total":2} · syncedAgo:{"when":"2 min ago"}',
  );
  expect(accountSummary(account(1, 'connected', { lastSyncAt: null }), [], t)).toBe('notSyncedYet');
  expect(accountSummary(account(2, 'needs_reconnect'), [calendar(1)], t)).toBe('reconnectToSee');
});

it('names an account by email, else its name', () => {
  expect(accountName(account(1), t)).toBe('a1@x.com');
  expect(accountName(account(1, 'connected', { email: null, displayName: 'Sam' }), t)).toBe('Sam');
});
