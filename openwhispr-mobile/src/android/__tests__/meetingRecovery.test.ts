const mockBaseline = jest.fn();
const mockRepair = jest.fn();
let mockAudio: { namespace: string; key: string; isCurrent(): boolean };
jest.mock('@/lib/meetingRecovery.ts', () => ({
  startMeetingRecoveryOnce: (...args: unknown[]) => mockBaseline(...args),
}));
jest.mock('@/lib/meetingAudioStorage', () => ({ meetingAudioContext: () => mockAudio }));
jest.mock('@/android/meetingRecordingRepair', () => ({
  repairAndroidMeetingRecordingPaths: (...args: unknown[]) => mockRepair(...args),
}));
jest.mock('@/lib/sentry', () => ({ Sentry: { captureException: jest.fn() } }));
import { startMeetingRecoveryOnce } from '@/lib/meetingRecovery.android';
let key = 0;
beforeEach(() => {
  jest.clearAllMocks();
  mockAudio = { namespace: 'account-a', key: String(++key), isCurrent: () => true };
});
async function flush() {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}
it('repairs once before starting baseline recovery for the same account revision', async () => {
  let done!: () => void;
  mockRepair.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      done = resolve;
    }),
  );
  startMeetingRecoveryOnce();
  startMeetingRecoveryOnce();
  expect(mockRepair).toHaveBeenCalledTimes(1);
  expect(mockBaseline).not.toHaveBeenCalled();
  done();
  await flush();
  expect(mockBaseline).toHaveBeenCalledTimes(1);
});
it('does not start current-account baseline recovery from a stale scan', async () => {
  let done!: () => void;
  mockRepair.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      done = resolve;
    }),
  );
  let current = true;
  mockAudio.isCurrent = () => current;
  startMeetingRecoveryOnce();
  current = false;
  mockAudio = { namespace: 'account-b', key: String(++key), isCurrent: () => true };
  done();
  await flush();
  expect(mockBaseline).not.toHaveBeenCalled();
});
it('reports repair failure and still starts current-account baseline recovery', async () => {
  mockRepair.mockRejectedValueOnce(new Error('File read failed'));
  startMeetingRecoveryOnce();
  await flush();
  expect(mockBaseline).toHaveBeenCalledTimes(1);
  expect(require('@/lib/sentry').Sentry.captureException).toHaveBeenCalledTimes(1);
});
