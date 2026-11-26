const mockDatabase = { query: {}, select: jest.fn() };
const mockOpen = jest.fn((name: string) => ({ name }));
jest.mock('expo-sqlite', () => ({
  openDatabaseSync: (...args: Parameters<typeof mockOpen>) => mockOpen(...args),
}));
jest.mock('drizzle-orm/expo-sqlite', () => ({ drizzle: () => mockDatabase }));
jest.mock('@/db/schema', () => ({}));
jest.mock('@/android/db/schema', () => jest.requireMock('@/db/schema'));

it('keeps the default database as the upstream Drizzle instance', () => {
  const { db } = require('@/db/index');
  expect(db).toBe(mockDatabase);
  expect(mockOpen).toHaveBeenCalledWith('openwhispr_notes.db');
});
