import { AppState, type AppStateStatus } from 'react-native';
import { AndroidDictation } from '../../../modules/android-dictation/src';
import { observeBubbleRestore } from '../bubbleRestore';

jest.mock('../../../modules/android-dictation/src', () => ({
  AndroidDictation: { restoreBubble: jest.fn(() => true) },
}));

const restoreBubble = AndroidDictation!.restoreBubble as jest.Mock;
let listener: (state: AppStateStatus) => void;
const remove = jest.fn();

beforeEach(() => {
  restoreBubble.mockReset().mockReturnValue(true);
  remove.mockReset();
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, handler) => {
    listener = handler as (state: AppStateStatus) => void;
    return { remove } as ReturnType<typeof AppState.addEventListener>;
  });
});

afterEach(() => jest.restoreAllMocks());

it('restores the bubble when the app launches', () => {
  observeBubbleRestore();
  expect(restoreBubble).toHaveBeenCalledTimes(1);
});

it('restores again only when the app returns to the front', () => {
  observeBubbleRestore();
  listener('background');
  listener('inactive');
  expect(restoreBubble).toHaveBeenCalledTimes(1);
  listener('active');
  expect(restoreBubble).toHaveBeenCalledTimes(2);
});

it('keeps the app running when Android refuses the restore', () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  restoreBubble.mockImplementation(() => {
    throw new Error('Allow display over other apps first.');
  });
  expect(() => observeBubbleRestore()).not.toThrow();
  expect(() => listener('active')).not.toThrow();
  expect(warn).toHaveBeenCalledTimes(2);
});

it('stops listening when the root unmounts', () => {
  observeBubbleRestore()();
  expect(remove).toHaveBeenCalledTimes(1);
});
