jest.mock('@/android/accountData', () => ({
  useAccountData: require('zustand').create(() => ({
    owner: 'account-a',
    audioNamespace: 'audio-a',
    revision: 1,
    blocked: false,
    error: null,
  })),
}));
jest.mock('expo-file-system/legacy', () => ({ documentDirectory: 'file:///fixture/' }));

import { useAccountData } from '@/android/accountData';
import * as scope from '../transcriptScope';
import * as androidScope from '../transcriptScope.android';
import * as audio from '../meetingAudioStorage';
import * as androidAudio from '../meetingAudioStorage.android';
import * as route from '../notes/noteRouteOwner';
import * as androidRoute from '../notes/noteRouteOwner.android';

beforeEach(() => {
  useAccountData.setState({
    owner: 'account-a',
    audioNamespace: 'audio-a',
    revision: 1,
    blocked: false,
    error: null,
  });
});

it('keeps the default device scope independent of Android account state', () => {
  const changed = jest.fn();
  const stop = scope.observeTranscriptScope(changed);
  const context = audio.meetingAudioContext();
  useAccountData.setState({ owner: null, blocked: true, error: 'Unavailable', revision: 2 });
  expect(scope.captureTranscriptScope()).toBeNull();
  expect(scope.isTranscriptScopeCurrent(null)).toBe(true);
  expect(context.isCurrent()).toBe(true);
  expect(audio.meetingAudioDirectory()).toBe('file:///fixture/');
  expect(route.getNotesRouteOwner()).toBeUndefined();
  const params = { folderId: '12' };
  expect(route.withNotesRouteOwner(params)).toBe(params);
  expect(changed).not.toHaveBeenCalled();
  stop();
});

it('invalidates Android work after A → B → A and stops observing after disposal', () => {
  const captured = androidScope.captureTranscriptScope();
  const context = androidAudio.meetingAudioContext();
  const changed = jest.fn();
  const stop = androidScope.observeTranscriptScope(changed);
  useAccountData.setState({ owner: 'account-b', revision: 2 });
  useAccountData.setState({ owner: 'account-a', revision: 3 });
  expect(androidScope.isTranscriptScopeCurrent(captured)).toBe(false);
  expect(context.isCurrent()).toBe(false);
  expect(changed).toHaveBeenCalledTimes(2);
  stop();
  useAccountData.setState({ revision: 4 });
  expect(changed).toHaveBeenCalledTimes(2);
});

it('retains Android audio namespaces and route ownership', () => {
  expect(androidScope.captureTranscriptScope()).toEqual({
    owner: 'account-a',
    key: 'history:audio-a',
    revision: 1,
  });
  expect(androidAudio.meetingAudioDirectory()).toBe('file:///fixture/account-audio/audio-a/');
  expect(androidRoute.withNotesRouteOwner({ folderId: '12' })).toEqual({
    folderId: '12',
    dataOwner: 'account-a',
  });
});

it.each([{ owner: null }, { blocked: true }, { error: 'Unavailable' }])(
  'refuses Android work while account data is unavailable: %p',
  (state) => {
    useAccountData.setState(state);
    expect(() => androidScope.captureTranscriptScope()).toThrow(/unavailable/);
    expect(() => androidAudio.meetingAudioContext()).toThrow(/unavailable/);
    expect(androidScope.isTranscriptScopeCurrent(null)).toBe(false);
  },
);
