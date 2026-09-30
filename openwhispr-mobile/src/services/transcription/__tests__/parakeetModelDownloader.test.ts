jest.mock('expo-file-system/legacy', () => ({
  createDownloadResumable: jest.fn(),
  deleteAsync: jest.fn(async () => undefined),
  getInfoAsync: jest.fn(),
  makeDirectoryAsync: jest.fn(async () => undefined),
  moveAsync: jest.fn(async () => undefined),
  readAsStringAsync: jest.fn(),
  writeAsStringAsync: jest.fn(async () => undefined),
}));
jest.mock('../../../../modules/parakeet-asr/src', () => ({
  ParakeetASR: {
    isAvailable: jest.fn(() => true),
    modelSpec: jest.fn(async () => ({
      repo: 'FluidInference/parakeet-tdt-0.6b-v2-coreml',
      directory: '/AppSupport/FluidAudio/Models/parakeet-tdt-0.6b-v2-coreml',
      stagingDirectory: '/AppSupport/FluidAudio/Models/parakeet-tdt-0.6b-v2-coreml.downloading',
      entries: ['Decoder.mlmodelc', 'parakeet_vocab.json'],
    })),
  },
}));

import * as FileSystem from 'expo-file-system/legacy';
import { AppState } from 'react-native';
import { ParakeetASR } from '../../../../modules/parakeet-asr/src';
import {
  MAX_STALL_KICKS,
  STALL_WINDOW_MS,
  cancelParakeetDownload,
  downloadParakeetModel,
  listParakeetRemoteFiles,
  stagedParakeetBytes,
} from '../parakeetModelDownloader';

const REPO = 'FluidInference/parakeet-tdt-0.6b-v2-coreml';
/** The repo's current commit, pinned for the whole run so listing, transfers and staging agree. */
const REVISION = 'ee09c569f73759e6d44c9bd16766f477b2b36d39';
const INSTALL = 'file:///AppSupport/FluidAudio/Models/parakeet-tdt-0.6b-v2-coreml';
const STAGING = `${INSTALL}.downloading`;
/** Records which revision the staged files were fetched from. */
const MARKER = `${STAGING}/.revision`;
const MODEL_API = `https://huggingface.co/api/models/${REPO}`;
const TREE_BASE = `${MODEL_API}/tree/${REVISION}`;
const WEIGHT = `${STAGING}/Decoder.mlmodelc/weights/weight.bin`;
/** One stall window plus one watchdog tick: exactly enough fake time for a single kick. */
const ONE_KICK_MS = STALL_WINDOW_MS + 10_000;

// Remote layout: two files inside the decoder bundle plus the root vocab. 1050 bytes total.
const REMOTE_SIZES: Record<string, number> = {
  'Decoder.mlmodelc/coremldata.bin': 100,
  'Decoder.mlmodelc/weights/weight.bin': 900,
  'parakeet_vocab.json': 50,
};
const TREE: Record<string, unknown> = {
  [MODEL_API]: { sha: REVISION },
  [`${TREE_BASE}/Decoder.mlmodelc?recursive=true`]: [
    { type: 'directory', path: 'Decoder.mlmodelc/weights', size: 0 },
    { type: 'file', path: 'Decoder.mlmodelc/coremldata.bin', size: 100 },
    { type: 'file', path: 'Decoder.mlmodelc/weights/weight.bin', size: 900 },
  ],
  [TREE_BASE]: [
    { type: 'file', path: 'README.md', size: 10 },
    { type: 'file', path: 'parakeet_vocab.json', size: 50 },
  ],
};

/** The decoder bundle plus a zero-byte file, which HuggingFace refuses to serve. */
const EMPTY_FILE = `${STAGING}/Decoder.mlmodelc/empty.bin`;
const EMPTY_FILE_TREE = [
  { type: 'file', path: 'Decoder.mlmodelc/coremldata.bin', size: 100 },
  { type: 'file', path: 'Decoder.mlmodelc/weights/weight.bin', size: 900 },
  { type: 'file', path: 'Decoder.mlmodelc/empty.bin', size: 0 },
];

type FakeResponse = { status: number; body: string };

function fakeFetch(overrides: Record<string, FakeResponse> = {}): typeof fetch {
  return jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const override = overrides[url];
    const tree = TREE[url];
    const response: FakeResponse = override
      ? override
      : tree
        ? { status: 200, body: JSON.stringify(tree) }
        : { status: 404, body: 'not found' };
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      text: async () => response.body,
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

const mockCreateDownloadResumable = FileSystem.createDownloadResumable as jest.MockedFunction<
  typeof FileSystem.createDownloadResumable
>;
const mockGetInfoAsync = FileSystem.getInfoAsync as jest.MockedFunction<
  typeof FileSystem.getInfoAsync
>;
const mockDeleteAsync = FileSystem.deleteAsync as jest.MockedFunction<
  typeof FileSystem.deleteAsync
>;
const mockMoveAsync = FileSystem.moveAsync as jest.MockedFunction<typeof FileSystem.moveAsync>;
const mockReadAsStringAsync = FileSystem.readAsStringAsync as jest.MockedFunction<
  typeof FileSystem.readAsStringAsync
>;
const mockWriteAsStringAsync = FileSystem.writeAsStringAsync as jest.MockedFunction<
  typeof FileSystem.writeAsStringAsync
>;
const mockParakeetASR = ParakeetASR as jest.Mocked<typeof ParakeetASR>;

/** Bytes "on disk" per destination uri, shared by the fake downloads and the getInfoAsync mock. */
const written = new Map<string, number>();
/** Contents of the staging revision marker; null when staging has no marker. */
let markerContent: string | null = null;

/** What getInfoAsync reports for a destination; `size` is overridable to fake a truncated file. */
function fakeFileInfo(
  uri: string,
  size: number | undefined = written.get(uri),
): FileSystem.FileInfo {
  if (uri === MARKER) {
    return (
      markerContent === null
        ? { exists: false, uri, isDirectory: false }
        : { exists: true, uri, size: markerContent.length, isDirectory: false }
    ) as never;
  }
  return written.has(uri)
    ? ({ exists: true, uri, size, isDirectory: false } as never)
    : ({ exists: false, uri, isDirectory: false } as never);
}

function remotePathOf(destination: string): string {
  return destination.slice(`${STAGING}/`.length);
}

/** Resolvers for every pauseAsync the fake is currently holding open (one per watchdog kick). */
type HeldPauses = Array<() => void>;

function releaseHeldPauses(held: HeldPauses): void {
  held.splice(0).forEach((release): void => release());
}

interface FakeResumableOptions {
  /** HTTP status a completed transfer reports, overall or per destination. */
  status?: number | ((destination: string) => number);
  /**
   * Destinations whose transfer never completes on its own (resolved only by pauseAsync).
   * `attempt` counts resumables created for that destination, starting at 1.
   */
  hang?: (destination: string, attempt: number) => boolean;
  /** When true, resumeAsync also hangs (used to exhaust the stall watchdog). */
  hangOnResume?: boolean;
  /**
   * The first N resumes each report fresh bytes and then hang again — a flaky link that recovers
   * after every kick. Later resumes complete normally.
   */
  progressThenHangOnResume?: number;
  /** HTTP status a completed *resume* reports (defaults to `status`). */
  resumeStatus?: number;
  /** When set, downloadAsync rejects with this error (the native transport failure). */
  rejectDownload?: Error;
  /** When true, pauseAsync rejects on every call instead of resolving the pending hang. */
  rejectPause?: boolean;
  /** When true, cancelAsync never settles the pending transfer (a native cancel that never completes). */
  cancelNeverSettles?: boolean;
  /**
   * Reject the pending transfer with this error on cancel instead of settling it. A real cancel
   * can do that: the native task fails its final move because staging is already gone.
   */
  rejectOnCancel?: Error;
  /**
   * Models the real native pause: it resolves the pending download immediately, but its own promise
   * (where the resume data lands) only settles when the test releases it.
   */
  deferPause?: HeldPauses;
  /**
   * Settle the pending transfer with `null` instead of `undefined` on pause/cancel. That is what a
   * device actually delivers: the legacy delegate resolves NSNull, which crosses the bridge as null
   * even though the typings promise undefined.
   */
  nativeNullSettle?: boolean;
}

const pauseMocks: jest.Mock[] = [];
const resumeMocks: jest.Mock[] = [];
const downloadMocks: jest.Mock[] = [];
const cancelMocks: jest.Mock[] = [];

function installResumableFactory(options: FakeResumableOptions = {}): void {
  const attempts = new Map<string, number>();
  mockCreateDownloadResumable.mockImplementation((_url, destination, _opts, callback) => {
    const attempt = (attempts.get(destination) ?? 0) + 1;
    attempts.set(destination, attempt);
    const expected = REMOTE_SIZES[remotePathOf(destination)] ?? 0;
    let pending: ((value: undefined | null) => void) | null = null;
    let failPending: ((error: Error) => void) | null = null;
    let cancelled = false;
    let resumes = 0;
    let reported = 0;
    const settled = options.nativeNullSettle ? null : undefined;
    const statusOf = (): number =>
      typeof options.status === 'function' ? options.status(destination) : (options.status ?? 200);
    const complete = (status = statusOf()): { status: number; uri: string } => {
      callback?.({ totalBytesWritten: expected / 2, totalBytesExpectedToWrite: expected });
      callback?.({ totalBytesWritten: expected, totalBytesExpectedToWrite: expected });
      written.set(destination, expected);
      return { status, uri: destination };
    };
    const hang = (): Promise<undefined | null> =>
      new Promise<undefined | null>((resolve, reject) => {
        pending = resolve;
        failPending = reject;
      });
    const downloadAsync = jest.fn(async () => {
      if (options.rejectDownload) throw options.rejectDownload;
      return options.hang?.(destination, attempt) ? hang() : complete();
    });
    // Like the real DownloadResumable: after cancelAsync a resume settles immediately without
    // touching native.
    const resumeAsync = jest.fn(async () => {
      if (cancelled) return settled;
      resumes += 1;
      if (options.hangOnResume) return hang();
      if (
        options.progressThenHangOnResume !== undefined &&
        resumes <= options.progressThenHangOnResume
      ) {
        reported += 1;
        callback?.({ totalBytesWritten: reported, totalBytesExpectedToWrite: expected });
        return hang();
      }
      return complete(options.resumeStatus ?? statusOf());
    });
    const pauseAsync = jest.fn(async () => {
      if (options.rejectPause) {
        throw new Error('native pause failed');
      }
      pending?.(settled);
      pending = null;
      const deferred = options.deferPause;
      if (deferred) {
        await new Promise<void>((resolve) => {
          deferred.push(resolve);
        });
      }
    });
    // Models the native task.cancel(): the pending transfer settles with no result and its
    // partially written temp data is discarded instead of being kept as resume data.
    const cancelAsync = jest.fn(async () => {
      cancelled = true;
      if (options.cancelNeverSettles) return;
      if (options.rejectOnCancel) {
        failPending?.(options.rejectOnCancel);
      } else {
        pending?.(settled);
      }
      pending = null;
      failPending = null;
    });
    pauseMocks.push(pauseAsync);
    resumeMocks.push(resumeAsync);
    downloadMocks.push(downloadAsync);
    cancelMocks.push(cancelAsync);
    return { downloadAsync, pauseAsync, resumeAsync, cancelAsync } as unknown as ReturnType<
      typeof FileSystem.createDownloadResumable
    >;
  });
}

async function flush(times = 30): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

function resumablesFor(destination: string): number {
  return mockCreateDownloadResumable.mock.calls.filter((call) => call[1] === destination).length;
}

/** Drives the downloader's AppState subscription (same helper as the screen suites). */
let appStateListeners: ((state: string) => void)[] = [];
let appStateRemove: jest.Mock;

describe('parakeetModelDownloader', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
    written.clear();
    // Staging, when it holds anything, was fetched from the pinned revision unless a test says so.
    markerContent = REVISION;
    pauseMocks.length = 0;
    resumeMocks.length = 0;
    downloadMocks.length = 0;
    cancelMocks.length = 0;
    appStateListeners = [];
    appStateRemove = jest.fn();
    jest.spyOn(AppState, 'addEventListener').mockImplementation(((
      _event: string,
      handler: (state: string) => void,
    ) => {
      appStateListeners.push(handler);
      return { remove: appStateRemove };
    }) as never);
    mockGetInfoAsync.mockImplementation(async (uri: string) => fakeFileInfo(uri));
    mockReadAsStringAsync.mockImplementation(async () => markerContent ?? '');
    mockWriteAsStringAsync.mockImplementation(async (uri: string, contents: string) => {
      if (uri === MARKER) {
        markerContent = contents;
      } else {
        written.set(uri, 0);
      }
    });
    mockDeleteAsync.mockImplementation(async (uri: string) => {
      if (uri === STAGING) {
        markerContent = null;
        [...written.keys()]
          .filter((key) => key.startsWith(`${STAGING}/`))
          .forEach((key) => written.delete(key));
      } else {
        written.delete(uri);
      }
    });
  });

  it('lists bundle files recursively and root files by exact name', async () => {
    const files = await listParakeetRemoteFiles(
      REPO,
      REVISION,
      ['Decoder.mlmodelc', 'parakeet_vocab.json'],
      fakeFetch(),
    );
    expect(files).toEqual([
      { path: 'Decoder.mlmodelc/coremldata.bin', size: 100 },
      { path: 'Decoder.mlmodelc/weights/weight.bin', size: 900 },
      { path: 'parakeet_vocab.json', size: 50 },
    ]);
  });

  it('rejects a listing whose file entry has no size', async () => {
    installResumableFactory();
    const httpClient = fakeFetch({
      [`${TREE_BASE}/Decoder.mlmodelc?recursive=true`]: {
        status: 200,
        body: JSON.stringify([{ type: 'file', path: 'Decoder.mlmodelc/coremldata.bin' }]),
      },
    });

    await expect(
      listParakeetRemoteFiles(REPO, REVISION, ['Decoder.mlmodelc'], httpClient),
    ).rejects.toThrow(/Unexpected response while listing/);

    // A sizeless entry has to stop the download before any bytes move: there would be nothing to
    // verify the finished file against, so partial weights could be installed as complete.
    await expect(downloadParakeetModel('v2', { httpClient })).rejects.toThrow(
      /Unexpected response while listing/,
    );
    expect(mockCreateDownloadResumable).not.toHaveBeenCalled();
  });

  it('rejects a model listing without a commit sha', async () => {
    installResumableFactory();
    const httpClient = fakeFetch({ [MODEL_API]: { status: 200, body: JSON.stringify({}) } });

    await expect(downloadParakeetModel('v2', { httpClient })).rejects.toThrow(
      /Unexpected response while listing/,
    );
    expect(mockCreateDownloadResumable).not.toHaveBeenCalled();
  });

  it('downloads every file into staging with byte-weighted progress, then installs atomically', async () => {
    installResumableFactory();
    const onProgress = jest.fn();

    await downloadParakeetModel('v2', { onProgress, httpClient: fakeFetch() });

    const destinations = mockCreateDownloadResumable.mock.calls.map((call) => call[1]);
    expect(destinations).toEqual([
      `${STAGING}/Decoder.mlmodelc/coremldata.bin`,
      WEIGHT,
      `${STAGING}/parakeet_vocab.json`,
    ]);
    // Transfers are pinned to the listed revision, never to the moving `main`.
    expect(mockCreateDownloadResumable.mock.calls[1][0]).toBe(
      `https://huggingface.co/${REPO}/resolve/${REVISION}/Decoder.mlmodelc/weights/weight.bin`,
    );

    const values = onProgress.mock.calls.map((call) => call[0] as number);
    expect(values).toContain(50 / 1050);
    expect(values).toContain(100 / 1050);
    expect(values[values.length - 1]).toBe(1);
    expect(values).toEqual([...values].sort((a, b) => a - b));

    // Install replaces whatever was there, and only after the last transfer finished.
    const lastTransfer = Math.max(...downloadMocks.map((mock) => mock.mock.invocationCallOrder[0]));
    const installDelete = mockDeleteAsync.mock.calls.findIndex((call) => call[0] === INSTALL);
    expect(installDelete).toBeGreaterThanOrEqual(0);
    const deleteOrder = mockDeleteAsync.mock.invocationCallOrder[installDelete];
    const [moveOrder] = mockMoveAsync.mock.invocationCallOrder;
    expect(mockMoveAsync).toHaveBeenCalledWith({ from: STAGING, to: INSTALL });
    expect(lastTransfer).toBeLessThan(deleteOrder);
    expect(deleteOrder).toBeLessThan(moveOrder);
  });

  it('skips files already complete in staging so a relaunched download resumes', async () => {
    installResumableFactory();
    written.set(WEIGHT, 900);
    const onProgress = jest.fn();

    await downloadParakeetModel('v2', { onProgress, httpClient: fakeFetch() });

    const destinations = mockCreateDownloadResumable.mock.calls.map((call) => call[1]);
    expect(destinations).toEqual([
      `${STAGING}/Decoder.mlmodelc/coremldata.bin`,
      `${STAGING}/parakeet_vocab.json`,
    ]);
    const values = onProgress.mock.calls.map((call) => call[0] as number);
    expect(values).toContain(1000 / 1050);
    expect(mockMoveAsync).toHaveBeenCalledTimes(1);
  });

  it('records the pinned revision in staging before any file is transferred', async () => {
    installResumableFactory();
    markerContent = null;

    await downloadParakeetModel('v2', { httpClient: fakeFetch() });

    const marker = mockWriteAsStringAsync.mock.calls.findIndex((call) => call[0] === MARKER);
    expect(mockWriteAsStringAsync.mock.calls[marker]).toEqual([MARKER, REVISION]);
    expect(mockWriteAsStringAsync.mock.invocationCallOrder[marker]).toBeLessThan(
      mockCreateDownloadResumable.mock.invocationCallOrder[0],
    );
  });

  it('clears staged files from another revision instead of reusing them', async () => {
    installResumableFactory();
    // Same size, different commit: size equality is not identity, so the old encoder must go.
    markerContent = 'a-previous-commit';
    written.set(WEIGHT, 900);

    await downloadParakeetModel('v2', { httpClient: fakeFetch() });

    const clear = mockDeleteAsync.mock.calls.findIndex((call) => call[0] === STAGING);
    expect(clear).toBeGreaterThanOrEqual(0);
    expect(mockDeleteAsync.mock.invocationCallOrder[clear]).toBeLessThan(
      mockCreateDownloadResumable.mock.invocationCallOrder[0],
    );
    expect(resumablesFor(WEIGHT)).toBe(1);
    expect(markerContent).toBe(REVISION);
    expect(mockMoveAsync).toHaveBeenCalledTimes(1);
  });

  it('rejects a non-2xx transfer, deletes the file and never installs', async () => {
    installResumableFactory({ status: 404 });

    await expect(downloadParakeetModel('v2', { httpClient: fakeFetch() })).rejects.toThrow(
      /HTTP 404/,
    );
    expect(mockDeleteAsync).toHaveBeenCalledWith(`${STAGING}/Decoder.mlmodelc/coremldata.bin`, {
      idempotent: true,
    });
    expect(mockMoveAsync).not.toHaveBeenCalled();
  });

  it('keeps earlier completed files staged when a later file fails', async () => {
    installResumableFactory({
      status: (destination) => (destination === WEIGHT ? 500 : 200),
    });

    await expect(downloadParakeetModel('v2', { httpClient: fakeFetch() })).rejects.toThrow(
      /HTTP 500/,
    );
    expect(mockDeleteAsync).not.toHaveBeenCalledWith(STAGING, expect.anything());
    expect(written.get(`${STAGING}/Decoder.mlmodelc/coremldata.bin`)).toBe(100);
    expect(mockMoveAsync).not.toHaveBeenCalled();
  });

  it('maps a rate-limited file download to the rate-limit message', async () => {
    installResumableFactory({ status: 429 });

    await expect(downloadParakeetModel('v2', { httpClient: fakeFetch() })).rejects.toThrow(
      /rate-limiting/,
    );
    expect(mockDeleteAsync).toHaveBeenCalledWith(`${STAGING}/Decoder.mlmodelc/coremldata.bin`, {
      idempotent: true,
    });
    expect(mockMoveAsync).not.toHaveBeenCalled();
  });

  it('reports a transport failure in plain language instead of the native error text', async () => {
    installResumableFactory({
      rejectDownload: new Error(
        'Unable to download file: Error Domain=NSURLErrorDomain Code=-1009 "The Internet connection appears to be offline."',
      ),
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    const download = downloadParakeetModel('v2', { httpClient: fakeFetch() });
    await expect(download).rejects.toThrow(/connection/);
    await expect(download).rejects.not.toThrow(/NSURLErrorDomain/);
    expect(mockMoveAsync).not.toHaveBeenCalled();
    // The native description is still logged for developers.
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('rejects a file whose size on disk does not match the listing', async () => {
    installResumableFactory();
    mockGetInfoAsync.mockImplementation(async (uri: string) => fakeFileInfo(uri, 1));

    await expect(downloadParakeetModel('v2', { httpClient: fakeFetch() })).rejects.toThrow(
      /incomplete/,
    );
    // The truncated body must not survive to be "reused" by the next attempt.
    expect(mockDeleteAsync).toHaveBeenCalledWith(`${STAGING}/Decoder.mlmodelc/coremldata.bin`, {
      idempotent: true,
    });
    expect(mockMoveAsync).not.toHaveBeenCalled();
  });

  it('surfaces a rate-limited listing without downloading anything', async () => {
    installResumableFactory();
    const httpClient = fakeFetch({
      [`${TREE_BASE}/Decoder.mlmodelc?recursive=true`]: { status: 429, body: '' },
    });

    await expect(downloadParakeetModel('v2', { httpClient })).rejects.toThrow(/rate-limiting/);
    expect(mockCreateDownloadResumable).not.toHaveBeenCalled();
  });

  it('refuses a second run for a version that is still transferring', async () => {
    installResumableFactory({ hang: (destination) => destination === WEIGHT });

    const first = downloadParakeetModel('v2', { httpClient: fakeFetch() });
    first.catch(() => undefined);
    await flush();
    expect(mockCreateDownloadResumable).toHaveBeenCalledTimes(2);

    // A second finisher would delete the first run's install and move an incomplete tree over it.
    await expect(downloadParakeetModel('v2', { httpClient: fakeFetch() })).rejects.toThrow(
      /already/i,
    );
    expect(mockCreateDownloadResumable).toHaveBeenCalledTimes(2);

    // The refused run must not have displaced the live one: its cancel still reaches the transfer.
    await cancelParakeetDownload('v2');
    expect(cancelMocks[1]).toHaveBeenCalledTimes(1);
    await expect(first).rejects.toThrow(/cancelled/i);
  });

  it('cancel aborts the in-flight transfer, removes staging and rejects the download', async () => {
    installResumableFactory({ hang: (destination) => destination === WEIGHT });

    const download = downloadParakeetModel('v2', { httpClient: fakeFetch() });
    await flush();
    expect(mockCreateDownloadResumable).toHaveBeenCalledTimes(2);

    await cancelParakeetDownload('v2');

    // cancelAsync, not pauseAsync: a pause keeps up to 445 MB of resume data in tmp that nothing
    // will ever resume, and it only goes away when iOS purges tmp under storage pressure.
    expect(cancelMocks[1]).toHaveBeenCalledTimes(1);
    expect(pauseMocks[1]).not.toHaveBeenCalled();
    expect(mockDeleteAsync).toHaveBeenCalledWith(STAGING, { idempotent: true });
    await expect(download).rejects.toThrow(/cancelled/i);
    expect(mockMoveAsync).not.toHaveBeenCalled();
  });

  it('cancel landing while the next file is starting stops it before any bytes move', async () => {
    installResumableFactory();
    const secondInfoRelease: { current: (() => void) | null } = { current: null };
    mockGetInfoAsync.mockImplementation(async (uri: string) => {
      if (uri === WEIGHT) {
        await new Promise<void>((resolve) => {
          secondInfoRelease.current = resolve;
        });
      }
      return fakeFileInfo(uri);
    });

    const download = downloadParakeetModel('v2', { httpClient: fakeFetch() });
    await flush();
    // First file finished and cleared itself off the run token; the second is stuck on the
    // getInfoAsync check that runs before its resumable is even created.
    expect(mockCreateDownloadResumable).toHaveBeenCalledTimes(1);

    await cancelParakeetDownload('v2');
    expect(mockDeleteAsync).toHaveBeenCalledWith(STAGING, { idempotent: true });

    secondInfoRelease.current?.();
    await flush();

    await expect(download).rejects.toThrow(/cancelled/i);
    expect(mockCreateDownloadResumable).toHaveBeenCalledTimes(2);
    expect(downloadMocks[1]).not.toHaveBeenCalled();
    expect(mockMoveAsync).not.toHaveBeenCalled();
  });

  it('kicks a stalled transfer with pause/resume after the stall window', async () => {
    jest.useFakeTimers();
    installResumableFactory({ hang: (destination) => destination === WEIGHT });

    const download = downloadParakeetModel('v2', { httpClient: fakeFetch() });
    await flush();
    expect(mockCreateDownloadResumable).toHaveBeenCalledTimes(2);

    await jest.advanceTimersByTimeAsync(ONE_KICK_MS);
    await flush();

    expect(pauseMocks[1]).toHaveBeenCalledTimes(1);
    expect(resumeMocks[1]).toHaveBeenCalledTimes(1);
    await download;
    expect(mockMoveAsync).toHaveBeenCalledTimes(1);
  });

  it('resumes after a stall kick even though the native pause settles with null', async () => {
    jest.useFakeTimers();
    installResumableFactory({
      hang: (destination) => destination === WEIGHT,
      nativeNullSettle: true,
    });

    const download = downloadParakeetModel('v2', { httpClient: fakeFetch() });
    await flush();

    await jest.advanceTimersByTimeAsync(ONE_KICK_MS);
    await flush();

    // A strict `=== undefined` loop would fall through to `result.status` on null and fail the
    // whole download on the first kick — the exact stall the watchdog exists to recover from.
    expect(resumeMocks[1]).toHaveBeenCalledTimes(1);
    await download;
    expect(mockMoveAsync).toHaveBeenCalledTimes(1);
  });

  it('keeps a transfer alive as long as each kick brings new bytes', async () => {
    jest.useFakeTimers();
    // A flaky link that recovers after every kick: more gaps than the kick budget, each followed
    // by real progress. Only consecutive dead kicks may count towards giving up.
    const recoveries = MAX_STALL_KICKS + 1;
    installResumableFactory({
      hang: (destination) => destination === WEIGHT,
      progressThenHangOnResume: recoveries,
    });

    const download = downloadParakeetModel('v2', { httpClient: fakeFetch() });
    await flush();

    for (let gap = 0; gap <= recoveries; gap += 1) {
      await jest.advanceTimersByTimeAsync(ONE_KICK_MS);
      await flush();
    }

    expect(resumeMocks[1]).toHaveBeenCalledTimes(recoveries + 1);
    expect(cancelMocks[1]).not.toHaveBeenCalled();
    await download;
    expect(mockMoveAsync).toHaveBeenCalledTimes(1);
  });

  it('treats returning to the foreground as fresh progress so a suspended interval is not a stall', async () => {
    jest.useFakeTimers();
    installResumableFactory({ hang: (destination) => destination === WEIGHT });

    const download = downloadParakeetModel('v2', { httpClient: fakeFetch() });
    download.catch(() => undefined);
    await flush();

    // Timers do not run while the phone is locked; the background session does. The first tick
    // after unlocking sees a stale timestamp even though the transfer is healthy.
    await jest.advanceTimersByTimeAsync(STALL_WINDOW_MS - 10_000);
    appStateListeners.forEach((notify) => notify('background'));
    appStateListeners.forEach((notify) => notify('active'));
    await jest.advanceTimersByTimeAsync(20_000);
    await flush();

    expect(pauseMocks[1]).not.toHaveBeenCalled();

    await cancelParakeetDownload('v2');
    await expect(download).rejects.toThrow(/cancelled/i);
    // Every file's subscription is released with its transfer (the first file's already was).
    expect(appStateRemove).toHaveBeenCalledTimes(appStateListeners.length);
  });

  it('gives up with a stall error once the kicks are exhausted', async () => {
    jest.useFakeTimers();
    installResumableFactory({
      hang: (destination) => destination === WEIGHT,
      hangOnResume: true,
    });

    const download = downloadParakeetModel('v2', { httpClient: fakeFetch() });
    // Claim the rejection now so advancing the fake timers never trips an unhandled rejection.
    download.catch(() => undefined);
    await flush();

    for (let kick = 0; kick <= MAX_STALL_KICKS; kick += 1) {
      await jest.advanceTimersByTimeAsync(ONE_KICK_MS);
      await flush();
    }

    await expect(download).rejects.toThrow(/stalled/);
    // Giving up cancels outright. Pausing first would park the partial body in tmp as resume data
    // that nothing ever resumes.
    expect(pauseMocks[1]).toHaveBeenCalledTimes(MAX_STALL_KICKS);
    expect(cancelMocks[1]).toHaveBeenCalledTimes(1);
    expect(mockMoveAsync).not.toHaveBeenCalled();
  });

  it('gives up through the stall promise when the native cancel never settles the transfer', async () => {
    jest.useFakeTimers();
    installResumableFactory({
      hang: (destination) => destination === WEIGHT,
      hangOnResume: true,
      cancelNeverSettles: true,
    });

    const download = downloadParakeetModel('v2', { httpClient: fakeFetch() });
    download.catch(() => undefined);
    await flush();

    for (let kick = 0; kick <= MAX_STALL_KICKS; kick += 1) {
      await jest.advanceTimersByTimeAsync(ONE_KICK_MS);
      await flush();
    }

    await expect(download).rejects.toThrow(/stalled/);
    expect(cancelMocks[1]).toHaveBeenCalledTimes(1);
    expect(mockMoveAsync).not.toHaveBeenCalled();
  });

  it('gives up with a stall error even when pauseAsync itself keeps rejecting', async () => {
    jest.useFakeTimers();
    installResumableFactory({
      hang: (destination) => destination === WEIGHT,
      rejectPause: true,
    });
    // Every rejected kick logs a __DEV__ warning; silence it so the suite output stays readable,
    // while still asserting the warning actually fires.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    const download = downloadParakeetModel('v2', { httpClient: fakeFetch() });
    // Claim the rejection now so advancing the fake timers never trips an unhandled rejection.
    download.catch(() => undefined);
    await flush();

    for (let kick = 0; kick <= MAX_STALL_KICKS; kick += 1) {
      await jest.advanceTimersByTimeAsync(ONE_KICK_MS);
      await flush();
    }

    await expect(download).rejects.toThrow(/stalled/);
    expect(pauseMocks[1]).toHaveBeenCalledTimes(MAX_STALL_KICKS);
    expect(cancelMocks[1]).toHaveBeenCalledTimes(1);
    expect(mockMoveAsync).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('retries a file once from a fresh URL when a resumed transfer answers non-2xx', async () => {
    jest.useFakeTimers();
    // The CDN link a resume replays is signed for an hour; past that it answers 403. The file is
    // not gone — a fresh resolve gets a fresh link.
    installResumableFactory({
      hang: (destination, attempt) => destination === WEIGHT && attempt === 1,
      resumeStatus: 403,
    });

    const download = downloadParakeetModel('v2', { httpClient: fakeFetch() });
    await flush();
    await jest.advanceTimersByTimeAsync(ONE_KICK_MS);
    await flush();

    await download;
    expect(resumablesFor(WEIGHT)).toBe(2);
    expect(mockCreateDownloadResumable.mock.calls[2][0]).toBe(
      `https://huggingface.co/${REPO}/resolve/${REVISION}/Decoder.mlmodelc/weights/weight.bin`,
    );
    // The 403 body that landed at the destination is not left behind for the retry to "verify".
    expect(mockDeleteAsync).toHaveBeenCalledWith(WEIGHT, { idempotent: true });
    expect(mockMoveAsync).toHaveBeenCalledTimes(1);
  });

  it('surfaces the status when the fresh retry fails as well', async () => {
    jest.useFakeTimers();
    installResumableFactory({
      hang: (destination) => destination === WEIGHT,
      resumeStatus: 403,
    });

    const download = downloadParakeetModel('v2', { httpClient: fakeFetch() });
    download.catch(() => undefined);
    await flush();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await jest.advanceTimersByTimeAsync(ONE_KICK_MS);
      await flush();
    }

    await expect(download).rejects.toThrow(/HTTP 403/);
    expect(resumablesFor(WEIGHT)).toBe(2);
    expect(mockMoveAsync).not.toHaveBeenCalled();
  });

  it('waits for the pause to store its resume data before resuming a stalled transfer', async () => {
    jest.useFakeTimers();
    const held: HeldPauses = [];
    installResumableFactory({
      hang: (destination) => destination === WEIGHT,
      deferPause: held,
    });

    const download = downloadParakeetModel('v2', { httpClient: fakeFetch() });
    await flush();
    expect(mockCreateDownloadResumable).toHaveBeenCalledTimes(2);

    await jest.advanceTimersByTimeAsync(ONE_KICK_MS);
    await flush();

    // The pause has already resolved the pending downloadAsync, but its own promise — where the
    // native side stores the resume data — has not settled. Resuming now would drop the Range
    // header and restart the 445 MB file from byte 0.
    expect(pauseMocks[1]).toHaveBeenCalledTimes(1);
    expect(resumeMocks[1]).not.toHaveBeenCalled();

    releaseHeldPauses(held);
    await flush();

    expect(resumeMocks[1]).toHaveBeenCalledTimes(1);
    await download;
    expect(mockMoveAsync).toHaveBeenCalledTimes(1);
  });

  it('does not resume a transfer cancelled while the stall pause was still in flight', async () => {
    jest.useFakeTimers();
    const held: HeldPauses = [];
    installResumableFactory({
      hang: (destination) => destination === WEIGHT,
      deferPause: held,
    });

    const download = downloadParakeetModel('v2', { httpClient: fakeFetch() });
    // Claim the rejection now so advancing the fake timers never trips an unhandled rejection.
    download.catch(() => undefined);
    await flush();
    expect(mockCreateDownloadResumable).toHaveBeenCalledTimes(2);

    // A stall kick: pauseAsync has already resolved the pending downloadAsync, so the loop is
    // sitting on `await pausing` while the pause itself is still unsettled.
    await jest.advanceTimersByTimeAsync(ONE_KICK_MS);
    await flush();
    expect(pauseMocks[1]).toHaveBeenCalledTimes(1);
    expect(resumeMocks[1]).not.toHaveBeenCalled();

    // The user cancels inside exactly that window, while the watchdog's pause is still held open.
    const cancel = cancelParakeetDownload('v2');
    await flush();
    releaseHeldPauses(held);
    await cancel;
    await flush();
    expect(cancelMocks[1]).toHaveBeenCalledTimes(1);

    // After cancelAsync a resume would settle without a result at once, spinning the loop with no
    // tick in between; the cancel check has to break it before the resume is even attempted.
    expect(resumeMocks[1]).not.toHaveBeenCalled();
    await expect(download).rejects.toThrow(/cancelled/i);
    expect(mockDeleteAsync).toHaveBeenCalledWith(STAGING, { idempotent: true });
    expect(mockMoveAsync).not.toHaveBeenCalled();
  });

  it('reports a cancellation, not a connection failure, when cancel fails the native task', async () => {
    // Cancel deletes staging, so the native task can fail its final move instead of settling with
    // no result. The user asked for this; it must not surface as "check your connection".
    installResumableFactory({
      hang: (destination) => destination === WEIGHT,
      rejectOnCancel: new Error('ERR_FILESYSTEM_CANNOT_SAVE: Unable to save file'),
    });

    const download = downloadParakeetModel('v2', { httpClient: fakeFetch() });
    download.catch(() => undefined);
    await flush();

    await cancelParakeetDownload('v2');

    await expect(download).rejects.toThrow(/cancelled/i);
    expect(mockMoveAsync).not.toHaveBeenCalled();
  });

  it('gives up when the stall pause itself never settles', async () => {
    jest.useFakeTimers();
    // Never released: the native pause promise hangs. The loop must not wait on it forever — that
    // is the one state where a stalled transfer could never fail and never finish.
    const held: HeldPauses = [];
    installResumableFactory({
      hang: (destination) => destination === WEIGHT,
      deferPause: held,
    });

    const download = downloadParakeetModel('v2', { httpClient: fakeFetch() });
    download.catch(() => undefined);
    await flush();

    for (let kick = 0; kick <= MAX_STALL_KICKS; kick += 1) {
      await jest.advanceTimersByTimeAsync(ONE_KICK_MS);
      await flush();
    }

    await expect(download).rejects.toThrow(/stalled/);
    expect(resumeMocks[1]).not.toHaveBeenCalled();
    expect(mockMoveAsync).not.toHaveBeenCalled();
  });

  it('creates a zero-byte file locally instead of transferring it', async () => {
    // HuggingFace answers 500 for zero-byte files; FluidAudio creates them locally too.
    installResumableFactory();
    const httpClient = fakeFetch({
      [`${TREE_BASE}/Decoder.mlmodelc?recursive=true`]: {
        status: 200,
        body: JSON.stringify(EMPTY_FILE_TREE),
      },
    });

    await downloadParakeetModel('v2', { httpClient });

    expect(mockWriteAsStringAsync).toHaveBeenCalledWith(EMPTY_FILE, '');
    const destinations = mockCreateDownloadResumable.mock.calls.map((call) => call[1]);
    expect(destinations).not.toContain(EMPTY_FILE);
    expect(mockMoveAsync).toHaveBeenCalledTimes(1);
  });

  it('skips a zero-byte file a previous attempt already created', async () => {
    installResumableFactory();
    written.set(EMPTY_FILE, 0);
    const httpClient = fakeFetch({
      [`${TREE_BASE}/Decoder.mlmodelc?recursive=true`]: {
        status: 200,
        body: JSON.stringify(EMPTY_FILE_TREE),
      },
    });

    await downloadParakeetModel('v2', { httpClient });

    expect(mockWriteAsStringAsync).not.toHaveBeenCalledWith(EMPTY_FILE, '');
    expect(mockMoveAsync).toHaveBeenCalledTimes(1);
  });

  it('treats an HTML body answered with 200 as rate limiting', async () => {
    // HuggingFace serves an HTML error page with a 200 while it is overloaded.
    installResumableFactory();
    const httpClient = fakeFetch({
      [`${TREE_BASE}/Decoder.mlmodelc?recursive=true`]: {
        status: 200,
        body: '<!DOCTYPE html><html><body>error</body></html>',
      },
    });

    await expect(downloadParakeetModel('v2', { httpClient })).rejects.toThrow(/rate-limiting/);
    expect(mockCreateDownloadResumable).not.toHaveBeenCalled();
  });

  it('clears staging for a version with nothing in flight, for the Settings action', async () => {
    // "Clear partial download" cancels a key that is not downloading; it must reclaim the staged
    // files without touching any transfer.
    installResumableFactory();

    await cancelParakeetDownload('v2');

    expect(mockDeleteAsync).toHaveBeenCalledWith(STAGING, { idempotent: true });
    expect(mockCreateDownloadResumable).not.toHaveBeenCalled();
  });

  it('a run cancelled during listing never installs over the run that replaced it', async () => {
    installResumableFactory();
    const listingRelease: { current: (() => void) | null } = { current: null };
    const passthrough = fakeFetch();
    let blockNextCall = true;
    const blockedFetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (blockNextCall) {
        blockNextCall = false;
        await new Promise<void>((resolve) => {
          listingRelease.current = resolve;
        });
      }
      return passthrough(input, init);
    }) as unknown as typeof fetch;

    const first = downloadParakeetModel('v2', { httpClient: blockedFetch });
    await flush();
    // Still listing: no resumable exists yet, so cancel can only rely on the run token.
    expect(mockCreateDownloadResumable).not.toHaveBeenCalled();

    await cancelParakeetDownload('v2');

    const second = downloadParakeetModel('v2', { httpClient: fakeFetch() });
    await second;
    expect(mockMoveAsync).toHaveBeenCalledTimes(1);
    expect(mockCreateDownloadResumable).toHaveBeenCalledTimes(3);

    // The stale run wakes up only now. With a per-version cancel flag the restart above would have
    // cleared it, letting this run finish and rename its staging over the freshly installed model.
    listingRelease.current?.();
    await expect(first).rejects.toThrow(/cancelled/i);
    expect(mockMoveAsync).toHaveBeenCalledTimes(1);
    expect(mockCreateDownloadResumable).toHaveBeenCalledTimes(3);
  });
});

describe('stagedParakeetBytes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockParakeetASR.isAvailable.mockReturnValue(true);
  });

  it('reports what an interrupted attempt left in staging, without the revision marker', async () => {
    mockGetInfoAsync.mockImplementation(async (uri: string) => {
      if (uri === STAGING) {
        return { exists: true, uri, size: 445 + 40, isDirectory: true, modificationTime: 0 };
      }
      if (uri === MARKER) {
        return { exists: true, uri, size: 40, isDirectory: false, modificationTime: 0 };
      }
      return { exists: false, uri, isDirectory: false };
    });

    await expect(stagedParakeetBytes('v2')).resolves.toBe(445);
    expect(mockGetInfoAsync).toHaveBeenCalledWith(STAGING);
  });

  it('reports 0 when staging holds nothing but the revision marker', async () => {
    // A run interrupted right after pinning the revision left no transfer progress to reuse, so
    // Settings must not offer to "clear" 40 bytes.
    mockGetInfoAsync.mockImplementation(
      async (uri: string) =>
        ({
          exists: uri === STAGING || uri === MARKER,
          uri,
          size: 40,
          isDirectory: uri === STAGING,
          modificationTime: 0,
        }) as never,
    );

    await expect(stagedParakeetBytes('v2')).resolves.toBe(0);
  });

  it('reports 0 when nothing is staged', async () => {
    mockGetInfoAsync.mockResolvedValue({ exists: false, uri: STAGING, isDirectory: false });

    await expect(stagedParakeetBytes('v2')).resolves.toBe(0);
  });

  it('reports 0 without the native module instead of failing on modelSpec', async () => {
    mockParakeetASR.isAvailable.mockReturnValue(false);

    await expect(stagedParakeetBytes('v2')).resolves.toBe(0);
    expect(mockParakeetASR.modelSpec).not.toHaveBeenCalled();
  });
});
