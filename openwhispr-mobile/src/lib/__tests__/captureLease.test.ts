import { acquireCaptureLease, releaseCaptureLease } from '../captureLease';
import { AppGroupStorage } from '../../../modules/app-group-storage/src';
import { Sentry } from '@/lib/sentry';

jest.mock('../../../modules/app-group-storage/src', () => ({
  AppGroupStorage: { acquireCaptureLease: jest.fn(), releaseCaptureLease: jest.fn() },
}));
jest.mock('@/lib/sentry', () => ({ Sentry: { captureException: jest.fn() } }));

describe('captureLease', () => {
  beforeEach(() => jest.clearAllMocks());

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
});
