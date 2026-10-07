const mockPipStart = jest.fn<Promise<string>, [string]>();
const mockCaptureMessage = jest.fn();

jest.mock('../../../modules/pip-tutorial/src', () => ({
  PipTutorial: {
    start: (video: string) => mockPipStart(video),
    stop: () => Promise.resolve(),
  },
}));
jest.mock('@/lib/sentry', () => ({
  Sentry: { captureMessage: (...args: unknown[]) => mockCaptureMessage(...args) },
}));

import { startKeyboardPipTutorial } from '../keyboardPipTutorial';

beforeEach(() => {
  mockPipStart.mockReset();
  mockCaptureMessage.mockReset();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('startKeyboardPipTutorial', () => {
  it('reports nothing when the overlay starts', async () => {
    mockPipStart.mockResolvedValue('started');

    await expect(startKeyboardPipTutorial()).resolves.toBe(true);

    expect(mockPipStart).toHaveBeenCalledWith('keyboard-install');
    expect(mockCaptureMessage).not.toHaveBeenCalled();
  });

  it('reports why the overlay did not start', async () => {
    mockPipStart.mockResolvedValue('timeout:possible=false');

    await expect(startKeyboardPipTutorial()).resolves.toBe(false);

    expect(mockCaptureMessage).toHaveBeenCalledWith('Keyboard PiP tutorial did not start', {
      level: 'warning',
      tags: { pipOutcome: 'timeout' },
      extra: { outcome: 'timeout:possible=false' },
    });
  });

  it.each(['stopped', 'unsupported'])(
    'does not report the expected outcome %s',
    async (outcome) => {
      mockPipStart.mockResolvedValue(outcome);

      await expect(startKeyboardPipTutorial()).resolves.toBe(false);

      expect(mockCaptureMessage).not.toHaveBeenCalled();
    },
  );

  it('reports a native start that never settles', async () => {
    jest.useFakeTimers();
    mockPipStart.mockReturnValue(new Promise<string>(() => undefined));

    const started = startKeyboardPipTutorial();
    await jest.advanceTimersByTimeAsync(2500);

    await expect(started).resolves.toBe(false);
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      'Keyboard PiP tutorial did not start',
      expect.objectContaining({ tags: { pipOutcome: 'js_timeout' } }),
    );
  });
});
