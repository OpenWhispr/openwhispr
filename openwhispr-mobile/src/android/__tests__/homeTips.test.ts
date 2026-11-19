import { TIP_COUNT, tipsVisible } from '../home/tipsState';

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
  it('goes once every video was watched, however often each one was', () => {
    expect(tipsVisible({ loaded: true, hidden: false, watched: [0, 1, 1] })).toBe(true);
    expect(TIP_COUNT).toBe(3);
    expect(tipsVisible({ loaded: true, hidden: false, watched: [0, 1, 2] })).toBe(false);
  });
});
