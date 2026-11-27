import { acquireCaptureLease, isCaptureLeaseHeld, releaseCaptureLease } from '../captureLease';
import { AppGroupStorage } from '../../../modules/app-group-storage/src';
import { Sentry } from '@/lib/sentry';

jest.mock('../../../modules/app-group-storage/src', () => ({
  AppGroupStorage: { acquireCaptureLease: jest.fn(), releaseCaptureLease: jest.fn() },
}));
jest.mock('@/lib/sentry', () => ({ Sentry: { captureException: jest.fn() } }));

describe('captureLease', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (AppGroupStorage.releaseCaptureLease as jest.Mock).mockReset();
  });

  it('acquires the native lease for the given owner', async () => {
    (AppGroupStorage.acquireCaptureLease as jest.Mock).mockResolvedValue(undefined);

    await acquireCaptureLease('meeting-cloud');

    expect(AppGroupStorage.acquireCaptureLease).toHaveBeenCalledWith('meeting-cloud');
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('resolves and reports to Sentry when the native acquire rejects', async () => {
    const failure = new Error('native failure');
    (AppGroupStorage.acquireCaptureLease as jest.Mock).mockRejectedValue(failure);

    await expect(acquireCaptureLease('meeting-local')).resolves.toBeUndefined();

    expect(Sentry.captureException).toHaveBeenCalledWith(failure, {
      tags: { feature: 'meeting-capture-lease' },
    });
  });

  it('forwards the owner on release', () => {
    releaseCaptureLease('meeting-local');

    expect(AppGroupStorage.releaseCaptureLease).toHaveBeenCalledWith('meeting-local');
  });

  it('never throws when the native release throws, and reports it to Sentry', () => {
    const failure = new Error('native release failure');
    (AppGroupStorage.releaseCaptureLease as jest.Mock).mockImplementation(() => {
      throw failure;
    });

    expect(() => releaseCaptureLease('meeting-cloud')).not.toThrow();

    expect(Sentry.captureException).toHaveBeenCalledWith(failure, {
      tags: { feature: 'meeting-capture-lease' },
    });
  });

  describe('isCaptureLeaseHeld', () => {
    afterEach(() => {
      releaseCaptureLease('meeting-cloud');
      releaseCaptureLease('meeting-local');
    });

    it('is held from a successful acquire until that owner releases', async () => {
      (AppGroupStorage.acquireCaptureLease as jest.Mock).mockResolvedValue(undefined);
      expect(isCaptureLeaseHeld()).toBe(false);

      await acquireCaptureLease('meeting-cloud');
      await acquireCaptureLease('meeting-local');
      expect(isCaptureLeaseHeld()).toBe(true);

      releaseCaptureLease('meeting-cloud');
      expect(isCaptureLeaseHeld()).toBe(true);
      releaseCaptureLease('meeting-local');
      expect(isCaptureLeaseHeld()).toBe(false);
    });

    it('is not held after a failed acquire', async () => {
      (AppGroupStorage.acquireCaptureLease as jest.Mock).mockRejectedValue(new Error('native'));

      await acquireCaptureLease('meeting-local');

      expect(isCaptureLeaseHeld()).toBe(false);
    });

    it('is released even when the native release throws', async () => {
      (AppGroupStorage.acquireCaptureLease as jest.Mock).mockResolvedValue(undefined);
      (AppGroupStorage.releaseCaptureLease as jest.Mock).mockImplementation(() => {
        throw new Error('native release failure');
      });

      await acquireCaptureLease('meeting-cloud');
      releaseCaptureLease('meeting-cloud');

      expect(isCaptureLeaseHeld()).toBe(false);
    });
  });
});
