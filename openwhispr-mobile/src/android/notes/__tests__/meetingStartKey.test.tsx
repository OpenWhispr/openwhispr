import React from 'react';
import { act, render, renderHook } from '@testing-library/react-native';
import { useMeetingStart } from '../meetingStart';

const mockSheet = jest.fn((_props: Record<string, unknown>) => null);
let mockKey: { providerId: string } | null = null;
let mockOnDevice = false;
jest.mock('../sheets', () => ({
  StartSheet: (props: Record<string, unknown>) => mockSheet(props),
}));
jest.mock('../calendar', () => ({ useTodayMeetings: () => ({ events: [], now: 0 }) }));
jest.mock('../start', () => ({ startMeeting: jest.fn() }));
jest.mock('../../meetingRouting', () => ({ meetingOnDevice: () => mockOnDevice }));
jest.mock('../../providers/liveMeeting', () => ({ meetingKey: () => mockKey }));
jest.mock('../../settings/ownKey', () => ({
  KEY_PROVIDERS: [
    { id: 'openai', name: 'OpenAI' },
    { id: 'deepgram', name: 'Deepgram' },
    { id: 'assemblyai', name: 'AssemblyAI' },
  ],
}));
jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
jest.mock('@/store/useNotesStore', () => ({
  useNotesStore: { getState: () => ({ isLocalAsrModelReady: async () => true }) },
}));
jest.mock('@/android/store/useNotesStore', () => jest.requireMock('@/store/useNotesStore'));

function shownSheet(key: { providerId: string } | null, onDevice = false) {
  mockKey = key;
  mockOnDevice = onDevice;
  const { result } = renderHook(() => useMeetingStart({}));
  act(() => result.current.open(null));
  render(<>{result.current.sheet}</>);
  return mockSheet.mock.calls.at(-1)![0];
}

it('names the key chosen for meetings, as Settings does', () => {
  expect(shownSheet({ providerId: 'assemblyai' })).toMatchObject({
    keyName: 'AssemblyAI',
    onDevice: false,
  });
  expect(shownSheet({ providerId: 'deepgram' }).keyName).toBe('Deepgram');
});

it('shows OpenWhispr Cloud with no key, and On device over a key', () => {
  expect(shownSheet(null).keyName).toBeNull();
  expect(shownSheet({ providerId: 'openai' }, true)).toMatchObject({
    keyName: null,
    onDevice: true,
  });
});
