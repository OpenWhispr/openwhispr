import { readWatched, TIP_COUNT, TIP_IDS, tipsVisible } from '../home/tipsState';

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => undefined),
}));

describe('tipsVisible', () => {
  it('waits until the saved state has loaded', () => {
    expect(tipsVisible({ loaded: false, hidden: false, watched: [] })).toBe(false);
  });
  it('goes once the person hides Tips', () => {
    expect(tipsVisible({ loaded: true, hidden: true, watched: [] })).toBe(false);
  });
  it('goes once every one of the six videos was watched', () => {
    expect(TIP_COUNT).toBe(6);
    expect(tipsVisible({ loaded: true, hidden: false, watched: ['dictate', 'size', 'hide'] })).toBe(
      true,
    );
    expect(tipsVisible({ loaded: true, hidden: false, watched: [...TIP_IDS] })).toBe(false);
  });
});

describe('readWatched', () => {
  it('maps the old three-tip positions onto the same tips', () => {
    expect(readWatched([0, 1, 2])).toEqual(['dictate', 'size', 'hide']);
  });
  it('keeps saved ids, drops anything unknown and repeats', () => {
    expect(readWatched(['assistant', 'edit', 'edit', 'nope', 7])).toEqual(['assistant', 'edit']);
  });
  it('reads nothing from a value that is not a list', () => {
    expect(readWatched(undefined)).toEqual([]);
    expect(readWatched('dictate')).toEqual([]);
  });
});
