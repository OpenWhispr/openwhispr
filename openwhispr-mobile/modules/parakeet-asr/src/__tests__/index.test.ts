type ParakeetASRBarrel = typeof import('../index').ParakeetASR;

// The barrel resolves the native module once, at import, so each test loads it fresh against the
// native surface it describes.
function loadWithNative(native: Record<string, unknown>): ParakeetASRBarrel {
  let barrel: ParakeetASRBarrel | undefined;
  jest.isolateModules(() => {
    jest.doMock('expo', () => ({ requireNativeModule: () => native }));
    barrel = (require('../index') as typeof import('../index')).ParakeetASR;
  });
  return barrel!;
}

describe('ParakeetASR on a native build that predates Orukeet', () => {
  // What an older binary's module answers: it only knows v2 and v3.
  const isModelDownloaded = jest.fn(async (version: string) => {
    if (version !== 'v2' && version !== 'v3') {
      throw new Error(`Unknown Parakeet version '${version}' (expected v2 or v3)`);
    }
    return true;
  });
  const olderNative = { isModelDownloaded };

  beforeEach(() => isModelDownloaded.mockClear());

  it('reports Orukeet as unsupported and v2/v3 as supported', () => {
    const barrel = loadWithNative(olderNative);

    expect(barrel.supportsVersion('orukeet')).toBe(false);
    expect(barrel.supportsVersion('v2')).toBe(true);
    expect(barrel.supportsVersion('v3')).toBe(true);
  });

  it('reads Orukeet as not downloaded without asking the native module', async () => {
    const barrel = loadWithNative(olderNative);

    await expect(barrel.isModelDownloaded('orukeet')).resolves.toBe(false);
    await expect(barrel.isModelDownloaded('v3')).resolves.toBe(true);
    expect(isModelDownloaded).toHaveBeenCalledTimes(1);
    expect(isModelDownloaded).toHaveBeenCalledWith('v3');
  });

  it('keeps recovery-aware UI checks compatible with old binaries', async () => {
    const barrel = loadWithNative(olderNative);
    await expect(barrel.isModelDownloadedAfterRecovery('orukeet')).resolves.toBe(false);
    await expect(barrel.isModelDownloadedAfterRecovery('v3')).resolves.toBe(true);
    expect(isModelDownloaded).toHaveBeenCalledTimes(1);
  });
});

describe('ParakeetASR on a native build that installs archives', () => {
  it('uses the recovery-aware API only for the model-picker check', async () => {
    const isModelDownloaded = jest.fn(async () => false);
    const isModelDownloadedAfterRecovery = jest.fn(async () => true);
    const barrel = loadWithNative({
      isModelDownloaded,
      isModelDownloadedAfterRecovery,
      installFromArchive: jest.fn(),
    });
    await expect(barrel.isModelDownloaded('orukeet')).resolves.toBe(false);
    await expect(barrel.isModelDownloadedAfterRecovery('orukeet')).resolves.toBe(true);
    expect(isModelDownloaded).toHaveBeenCalledTimes(1);
    expect(isModelDownloadedAfterRecovery).toHaveBeenCalledWith('orukeet');
  });

  it('supports Orukeet and asks the native module whether it is downloaded', async () => {
    const isModelDownloaded = jest.fn(async () => true);
    const barrel = loadWithNative({ isModelDownloaded, installFromArchive: jest.fn() });

    expect(barrel.supportsVersion('orukeet')).toBe(true);
    await expect(barrel.isModelDownloaded('orukeet')).resolves.toBe(true);
    expect(isModelDownloaded).toHaveBeenCalledWith('orukeet');
  });
});
