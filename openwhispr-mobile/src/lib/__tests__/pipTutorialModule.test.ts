import { Platform } from 'react-native';

const mockNativeStart = jest.fn<Promise<string | boolean>, [string]>();

jest.mock('expo', () => ({
  requireNativeModule: () => ({
    isAvailable: () => true,
    start: (video: string) => mockNativeStart(video),
    stop: () => Promise.resolve(),
  }),
}));

// The module resolves its native half on import, and only on iOS.
Platform.OS = 'ios';
const { PipTutorial } =
  require('../../../modules/pip-tutorial/src') as typeof import('../../../modules/pip-tutorial/src');

beforeEach(() => {
  mockNativeStart.mockReset();
});

describe('PipTutorial.start', () => {
  it('passes the native outcome through', async () => {
    mockNativeStart.mockResolvedValue('timeout:possible=false');

    await expect(PipTutorial.start('keyboard-install')).resolves.toBe('timeout:possible=false');
  });

  // An OTA update can run this JS on a build whose native start still resolves a boolean.
  it.each([
    [true, 'started'],
    [false, 'failed'],
  ])('maps an older build’s %s to %s', async (legacy, outcome) => {
    mockNativeStart.mockResolvedValue(legacy);

    await expect(PipTutorial.start('keyboard-install')).resolves.toBe(outcome);
  });

  it('reports a native call that throws', async () => {
    mockNativeStart.mockRejectedValue(new Error('boom'));

    await expect(PipTutorial.start('keyboard-install')).resolves.toBe('error');
  });
});
