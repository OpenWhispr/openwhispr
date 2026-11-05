import { cleanupAsync, renderHook } from '@testing-library/react-native';
import type { Note } from '@/data';

jest.mock('../useAndroidCopy', () => {
  throw new Error('Android copy reached default date grouping');
});

afterEach(async () => {
  await cleanupAsync();
  jest.useRealTimers();
});

it('keeps default date grouping cached across midnight until the notes array changes', () => {
  const { useNoteBuckets } =
    jest.requireActual<typeof import('../useNoteBuckets')>('../useNoteBuckets');
  jest.useFakeTimers({ now: new Date(2026, 10, 3, 23, 59) });
  const notes = [{ id: 7, updatedAt: new Date(2026, 10, 3, 12).toISOString() }] as Note[];
  const hook = renderHook(({ rows }: { rows: Note[] }) => useNoteBuckets(rows), {
    initialProps: { rows: notes },
  });
  const original = hook.result.current;
  expect(original[0].key).toBe('today');
  jest.setSystemTime(new Date(2026, 10, 4, 0, 1));
  hook.rerender({ rows: notes });
  expect(hook.result.current).toBe(original);
  hook.rerender({ rows: [...notes] });
  expect(hook.result.current[0].key).toBe('yesterday');
  expect(hook.result.current[0].notes[0]).toBe(notes[0]);
});
