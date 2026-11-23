import { renderHook } from '@testing-library/react-native';
import { useCloudMeeting } from '../useCloudMeeting';
import { startRealtimeMeetingWs } from '@/android/RealtimeMeetingWsService';
import { liveMeetingDeps } from '@/android/providers/liveMeeting';

jest.mock('@/android/RealtimeMeetingWsService', () => ({
  startRealtimeMeetingWs: jest.fn(() => new Promise(() => undefined)),
}));
jest.mock('@/android/providers/liveMeeting', () => ({ liveMeetingDeps: jest.fn() }));

const start = jest.mocked(startRealtimeMeetingWs);
const deps = jest.mocked(liveMeetingDeps);
beforeEach(() => jest.clearAllMocks());

it("connects with the key saved for meetings, in the meeting's language", () => {
  const fetchClientSecret = jest.fn();
  deps.mockReturnValue({ fetchClientSecret });
  renderHook(() => useCloudMeeting({ enabled: true, language: 'fr' }));
  expect(deps).toHaveBeenCalledWith('fr');
  expect(start.mock.calls[0][2]).toMatchObject({ fetchClientSecret });
});

it('shows the error and connects nothing when the saved key is gone', () => {
  deps.mockImplementation(() => {
    throw new Error('Add your deepgram key again in Settings → Processing.');
  });
  const { result } = renderHook(() => useCloudMeeting({ enabled: true }));
  expect(start).not.toHaveBeenCalled();
  expect(result.current.status).toBe('error');
  expect(result.current.error).toContain('deepgram');
});
