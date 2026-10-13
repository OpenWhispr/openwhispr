import { AppState } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import { ParakeetASR, type ParakeetVersion } from '../../../modules/parakeet-asr/src';

export interface ParakeetRemoteFile {
  /** Path relative to the HuggingFace repo root, e.g. "Encoder.mlmodelc/weights/weight.bin". */
  path: string;
  /** Size in bytes from the HuggingFace tree listing. Never negative. */
  size: number;
}

export interface DownloadParakeetModelOptions {
  /** Fraction complete in [0, 1], byte-weighted across every file of the model. */
  onProgress?: (progress: number) => void;
  /** Injectable for tests; defaults to the global fetch. */
  httpClient?: typeof globalThis.fetch;
}

interface HuggingFaceTreeItem {
  type: 'file' | 'directory';
  path: string;
  size?: number;
}

interface OneFileDownload {
  run: DownloadRun;
  remotePath: string;
  url: string;
  destination: string;
  expectedSize: number;
  onBytes: (bytesWritten: number) => void;
}

const HUGGINGFACE_BASE_URL = 'https://huggingface.co';

/**
 * No bytes on the active file for this long means the connection is stalled. FluidAudio settled
 * on the same window after seeing the HF CDN freeze mid-encoder (FluidInference/FluidAudio#810).
 */
export const STALL_WINDOW_MS = 120_000;
/** Consecutive dead pause/resume kicks a stalled transfer gets before we give up with an error. */
export const MAX_STALL_KICKS = 3;
const WATCHDOG_TICK_MS = 10_000;
/** File in staging that records the repo commit its contents were fetched from. */
const REVISION_MARKER = '.revision';

const RATE_LIMIT_MESSAGE =
  'Hugging Face is rate-limiting downloads right now. Please try again in a few minutes.';
const STALLED_MESSAGE = 'The download stalled. Check your connection and try again.';
const TRANSPORT_MESSAGE = "Couldn't download the model. Check your connection and try again.";
const UNEXPECTED_LISTING_MESSAGE =
  'Unexpected response while listing the model files. Please try again.';
const ALREADY_RUNNING_MESSAGE = 'This model is already downloading.';

/** One attempt at downloading a version. Cancellation is tracked here rather than per version. */
interface DownloadRun {
  /** Set by cancelParakeetDownload; every cancel check inside this run reads it. */
  cancelled: boolean;
  /** The transfer currently in flight, so a cancel can abort it. Null between files. */
  resumable: FileSystem.DownloadResumable | null;
}

// One transfer per version at a time; the store already serializes downloads. The map holds the
// *current* run, but each run owns its cancelled flag: a run cancelled while it was still listing
// files must stay cancelled even after a restart registers a replacement, otherwise it runs to
// completion and renames its staging directory over the live run's.
const activeRuns = new Map<ParakeetVersion, DownloadRun>();

class DownloadCancelledError extends Error {
  constructor() {
    super('Download cancelled.');
    this.name = 'DownloadCancelledError';
  }
}

class DownloadStalledError extends Error {
  constructor() {
    super(STALLED_MESSAGE);
    this.name = 'DownloadStalledError';
  }
}

/** A resumed task answered non-2xx: its resume data replays a signed CDN link that has expired. */
class ResumeRejectedError extends Error {
  constructor(readonly status: number) {
    super(`Resumed transfer answered HTTP ${status}.`);
    this.name = 'ResumeRejectedError';
  }
}

function httpError(remotePath: string, status: number): Error {
  return new Error(`Couldn't download ${remotePath} (HTTP ${status}).`);
}

function isRateLimited(status: number): boolean {
  return status === 429 || status === 503;
}

function parentDirectoryOf(uri: string): string {
  return uri.slice(0, uri.lastIndexOf('/'));
}

async function stagingDirectoryUri(version: ParakeetVersion): Promise<string> {
  const spec = await ParakeetASR.modelSpec(version);
  return `file://${spec.stagingDirectory}`;
}

async function fetchJson(httpClient: typeof globalThis.fetch, url: string): Promise<unknown> {
  const response = await httpClient(url, { headers: { Accept: 'application/json' } });
  if (isRateLimited(response.status)) {
    throw new Error(RATE_LIMIT_MESSAGE);
  }
  if (!response.ok) {
    throw new Error(`Couldn't list the model files (HTTP ${response.status}). Please try again.`);
  }
  const body = await response.text();
  // HuggingFace occasionally answers 200 with an HTML error page while it is overloaded.
  if (body.trimStart().startsWith('<')) {
    throw new Error(RATE_LIMIT_MESSAGE);
  }
  return JSON.parse(body);
}

async function fetchTree(
  httpClient: typeof globalThis.fetch,
  url: string,
): Promise<HuggingFaceTreeItem[]> {
  const parsed = await fetchJson(httpClient, url);
  // A 200 carrying something other than the tree array (an error envelope, a redirect payload)
  // must fail as a listing error instead of crashing on items.filter further down.
  if (!Array.isArray(parsed)) {
    throw new Error(UNEXPECTED_LISTING_MESSAGE);
  }
  return parsed as HuggingFaceTreeItem[];
}

/**
 * The repo's current commit. Listing, transfers and staging are all pinned to it: `main` can move
 * between two attempts, and a re-export of the same architecture produces weight files of exactly
 * the same size, so size-based reuse of staged files is only safe within one revision.
 */
async function fetchRevision(httpClient: typeof globalThis.fetch, repo: string): Promise<string> {
  const parsed = await fetchJson(httpClient, `${HUGGINGFACE_BASE_URL}/api/models/${repo}`);
  const sha = (parsed as { sha?: unknown } | null)?.sha;
  if (typeof sha !== 'string' || sha.length === 0) {
    throw new Error(UNEXPECTED_LISTING_MESSAGE);
  }
  return sha;
}

/** The tree API sizes every file entry; a missing size means the listing itself is malformed. */
function toRemoteFile(item: HuggingFaceTreeItem): ParakeetRemoteFile {
  if (typeof item.size !== 'number') {
    throw new Error(UNEXPECTED_LISTING_MESSAGE);
  }
  return { path: item.path, size: item.size };
}

/**
 * Resolve FluidAudio's required entries to concrete files at one revision. `.mlmodelc` bundles are
 * directories (coremldata.bin, model.mil, weights/weight.bin, …) listed with one recursive call
 * each; plain entries (the vocab json) are looked up in the repo root.
 */
export async function listParakeetRemoteFiles(
  repo: string,
  revision: string,
  entries: readonly string[],
  httpClient: typeof globalThis.fetch = globalThis.fetch,
): Promise<ParakeetRemoteFile[]> {
  const treeUrl = `${HUGGINGFACE_BASE_URL}/api/models/${repo}/tree/${revision}`;
  const files: ParakeetRemoteFile[] = [];
  let rootListing: HuggingFaceTreeItem[] | null = null;

  for (const entry of entries) {
    if (entry.endsWith('.mlmodelc')) {
      const items = await fetchTree(httpClient, `${treeUrl}/${entry}?recursive=true`);
      const bundleFiles = items.filter((item) => item.type === 'file');
      if (bundleFiles.length === 0) {
        throw new Error(`Model bundle "${entry}" is missing from ${repo}.`);
      }
      bundleFiles.forEach((item) => files.push(toRemoteFile(item)));
      continue;
    }

    if (rootListing === null) {
      rootListing = await fetchTree(httpClient, treeUrl);
    }
    const match = rootListing.find((item) => item.type === 'file' && item.path === entry);
    if (!match) {
      throw new Error(`Model file "${entry}" is missing from ${repo}.`);
    }
    files.push(toRemoteFile(match));
  }

  return files;
}

/**
 * Keep staging only if it was fetched from this revision; otherwise start it over with the marker
 * written first, so a run interrupted at any later point still leaves an attributable directory.
 */
async function prepareStaging(stagingDirectory: string, revision: string): Promise<void> {
  const marker = `${stagingDirectory}/${REVISION_MARKER}`;
  const info = await FileSystem.getInfoAsync(marker);
  if (info.exists && (await FileSystem.readAsStringAsync(marker)) === revision) return;
  await FileSystem.deleteAsync(stagingDirectory, { idempotent: true });
  await FileSystem.makeDirectoryAsync(stagingDirectory, { intermediates: true });
  await FileSystem.writeAsStringAsync(marker, revision);
}

/**
 * Race a transfer against the watchdog's give-up. A rejected transfer is the native transport
 * failing (offline, DNS, TLS); its NSError description is not something to show a user.
 */
async function transfer(
  run: DownloadRun,
  start: () => Promise<FileSystem.FileSystemDownloadResult | undefined>,
  stalled: Promise<never>,
): Promise<FileSystem.FileSystemDownloadResult | undefined | null> {
  try {
    return await Promise.race([start(), stalled]);
  } catch (error) {
    if (error instanceof DownloadStalledError) throw error;
    // A cancel deletes staging, so the native task can fail its final move instead of settling
    // with no result. The user asked for that; it is not a broken connection.
    if (run.cancelled) throw new DownloadCancelledError();
    if (__DEV__) {
      console.warn('[parakeetModelDownloader] transfer failed', error);
    }
    throw new Error(TRANSPORT_MESSAGE);
  }
}

async function downloadOneFile(download: OneFileDownload): Promise<void> {
  let lastProgressAt = Date.now();
  let kicks = 0;
  let gaveUp = false;
  let resumed = false;
  let rejectStalled: ((error: Error) => void) | null = null;
  // Settles only if the watchdog gives up; see the watchdog below.
  const stalled = new Promise<never>((_resolve, reject) => {
    rejectStalled = reject;
  });

  const resumable = FileSystem.createDownloadResumable(
    download.url,
    download.destination,
    // sessionType defaults to BACKGROUND on iOS: the transfer survives the phone locking and app
    // switches, exactly like the Whisper download. The finished file only appears at
    // `destination` once complete, so staging never holds partial files.
    {},
    (event: FileSystem.DownloadProgressData): void => {
      lastProgressAt = Date.now();
      // Bytes arrived, so the last kick worked. Only consecutive dead kicks count towards giving up.
      kicks = 0;
      download.onBytes(event.totalBytesWritten);
    },
  );
  download.run.resumable = resumable;

  // Holds the most recent pauseAsync. pauseAsync resolves the pending downloadAsync/resumeAsync with
  // undefined *before* its own promise settles, and the resume data only lands on the JS object when
  // that promise resolves — resuming in that gap restarts the file from byte 0 (445 MB again).
  let pausing: Promise<void> = Promise.resolve();
  let watchdog: ReturnType<typeof setInterval> | undefined;
  // JS timers stop while the app is suspended; the background session does not. Without this the
  // first tick after unlocking would read the pre-suspension timestamp as a two-minute stall and
  // kick a transfer that was progressing the whole time.
  const foreground = AppState.addEventListener('change', (state): void => {
    if (state === 'active') lastProgressAt = Date.now();
  });
  try {
    // A cancel landing in the gap between the caller's per-file check and this registration must
    // stop the transfer before it starts: nothing else can pause a download that never called
    // downloadAsync(), and the caller may already have deleted the staging directory this would
    // write into.
    if (download.run.cancelled) {
      throw new DownloadCancelledError();
    }

    // pauseAsync resolves the pending downloadAsync/resumeAsync with undefined; the loop below
    // reacts to that. But a pause can itself reject (the native task already finished, or the OS
    // couldn't produce resume data), and giving up must not depend on that succeeding — otherwise
    // a stall could hang forever with no rejection. `stalled` gives the watchdog an unconditional
    // way to end the transfer once the kicks are exhausted.
    watchdog = setInterval((): void => {
      if (gaveUp || Date.now() - lastProgressAt < STALL_WINDOW_MS) return;
      lastProgressAt = Date.now();
      kicks += 1;
      if (kicks > MAX_STALL_KICKS) {
        // Cancel outright. Pausing first would park the partial body in tmp as resume data that
        // nothing ever resumes.
        gaveUp = true;
        resumable.cancelAsync().catch(() => undefined);
        rejectStalled?.(new DownloadStalledError());
        return;
      }
      pausing = resumable.pauseAsync().then(
        (): void => undefined,
        (error: unknown): void => {
          if (__DEV__) {
            console.warn(
              '[parakeetModelDownloader] pauseAsync failed while kicking a stalled transfer',
              error,
            );
          }
        },
      );
    }, WATCHDOG_TICK_MS);

    let result = await transfer(download.run, () => resumable.downloadAsync(), stalled);
    // `== null`: the typings say a paused/cancelled task resolves undefined, but the legacy iOS
    // delegate resolves NSNull, which reaches JS as null.
    while (result == null) {
      // Unconditional give-up. `stalled` normally wins the race, but after cancelAsync every
      // resumeAsync resolves undefined immediately, so without this guard an unlucky microtask
      // order would spin the loop forever.
      if (gaveUp) throw new DownloadStalledError();
      // The pause has to have stored its resume data before we resume, or the Range header is lost.
      // Raced against the give-up: a native pause that never settles must not park the loop here
      // forever, which is the one state where a stalled transfer neither fails nor finishes.
      await Promise.race([pausing, stalled]);
      // Checked *after* that wait, not before it: a cancel landing while the pause was in flight
      // has already deleted the staging directory, and a resume would start a fresh native task
      // for a file nothing will ever install.
      if (download.run.cancelled) throw new DownloadCancelledError();
      resumed = true;
      result = await transfer(download.run, () => resumable.resumeAsync(), stalled);
    }

    if (result.status < 200 || result.status >= 300) {
      await FileSystem.deleteAsync(download.destination, { idempotent: true });
      if (isRateLimited(result.status)) throw new Error(RATE_LIMIT_MESSAGE);
      if (resumed) throw new ResumeRejectedError(result.status);
      throw httpError(download.remotePath, result.status);
    }

    // A truncated body or an HTML error page must never be installed as model weights.
    const info = await FileSystem.getInfoAsync(download.destination);
    if (!info.exists || info.size !== download.expectedSize) {
      await FileSystem.deleteAsync(download.destination, { idempotent: true });
      throw new Error('The downloaded model file was incomplete. Please try again.');
    }
  } finally {
    foreground.remove();
    if (watchdog !== undefined) clearInterval(watchdog);
    if (download.run.resumable === resumable) {
      download.run.resumable = null;
    }
  }
}

/**
 * Resume data replays the CDN link the first request was redirected to, and that link is signed
 * for about an hour. A resumed transfer that comes back non-2xx is therefore retried once from
 * scratch: a fresh task follows a fresh redirect.
 */
async function downloadFile(download: OneFileDownload): Promise<void> {
  try {
    await downloadOneFile(download);
  } catch (error) {
    if (!(error instanceof ResumeRejectedError)) throw error;
    try {
      await downloadOneFile(download);
    } catch (retryError) {
      throw retryError instanceof ResumeRejectedError
        ? httpError(download.remotePath, retryError.status)
        : retryError;
    }
  }
}

/**
 * Download one Parakeet version into FluidAudio's install directory using background-session
 * resumable downloads, one file at a time. Completed files left in staging by an interrupted run
 * at the same revision are reused, so a relaunch only redoes the file that was in flight.
 */
export async function downloadParakeetModel(
  version: ParakeetVersion,
  options: DownloadParakeetModelOptions = {},
): Promise<void> {
  const httpClient = options.httpClient ?? globalThis.fetch;
  // Two live runs would race each other's staging and install; a second finisher could replace a
  // complete install with an incomplete tree.
  const current = activeRuns.get(version);
  if (current && !current.cancelled) {
    throw new Error(ALREADY_RUNNING_MESSAGE);
  }
  const run: DownloadRun = { cancelled: false, resumable: null };
  activeRuns.set(version, run);

  try {
    const spec = await ParakeetASR.modelSpec(version);
    const installDirectory = `file://${spec.directory}`;
    const stagingDirectory = `file://${spec.stagingDirectory}`;
    const revision = await fetchRevision(httpClient, spec.repo);
    const files = await listParakeetRemoteFiles(spec.repo, revision, spec.entries, httpClient);

    if (run.cancelled) throw new DownloadCancelledError();
    await prepareStaging(stagingDirectory, revision);

    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    let completedBytes = 0;
    const report = (activeBytes: number): void => {
      if (totalBytes > 0) {
        options.onProgress?.(Math.min((completedBytes + activeBytes) / totalBytes, 1));
      }
    };

    for (const file of files) {
      if (run.cancelled) throw new DownloadCancelledError();

      const destination = `${stagingDirectory}/${file.path}`;
      const existing = await FileSystem.getInfoAsync(destination);
      if (existing.exists && existing.size === file.size) {
        completedBytes += file.size;
        report(0);
        continue;
      }

      await FileSystem.makeDirectoryAsync(parentDirectoryOf(destination), { intermediates: true });
      if (file.size === 0) {
        // HuggingFace answers 500 for zero-byte files; FluidAudio creates them locally as well.
        await FileSystem.writeAsStringAsync(destination, '');
        continue;
      }

      await downloadFile({
        run,
        remotePath: file.path,
        url: `${HUGGINGFACE_BASE_URL}/${spec.repo}/resolve/${revision}/${encodeURI(file.path)}`,
        destination,
        expectedSize: file.size,
        onBytes: report,
      });
      completedBytes += file.size;
      report(0);
    }

    if (run.cancelled) throw new DownloadCancelledError();

    // Only a complete, verified set ever lands where FluidAudio's modelsExist() looks; the move is a
    // same-directory rename. Any leftover from FluidAudio's own (broken) downloader is replaced.
    // The revision marker moves along: FluidAudio reads only the files it names, and keeping it
    // means a failed move leaves staging reusable instead of forcing a full re-download.
    await FileSystem.deleteAsync(installDirectory, { idempotent: true });
    await FileSystem.moveAsync({ from: stagingDirectory, to: installDirectory });
  } finally {
    // Deregister only if a restart hasn't already claimed the slot for its own run.
    if (activeRuns.get(version) === run) activeRuns.delete(version);
  }
}

/** Stop the in-flight transfer for a version and reclaim its staging directory. */
export async function cancelParakeetDownload(version: ParakeetVersion): Promise<void> {
  // modelSpec below rejects off-iOS / in Expo Go, where deleteModel and release simply no-op.
  if (!ParakeetASR.isAvailable()) return;
  const run = activeRuns.get(version);
  if (run) {
    run.cancelled = true;
    // cancelAsync rather than pauseAsync: both settle the pending downloadAsync/resumeAsync, but
    // a pause keeps the partial body (up to 445 MB) in tmp as resume data nothing will ever use,
    // and iOS only reclaims it under storage pressure. A plain cancel discards it right away.
    if (run.resumable) {
      await run.resumable.cancelAsync().catch(() => undefined);
    }
  }
  await FileSystem.deleteAsync(await stagingDirectoryUri(version), { idempotent: true });
}

/**
 * Bytes of transfer progress a previous attempt left in staging for this version (0 when nothing
 * is staged). The free-space gate subtracts them from what a retry still needs, and Settings
 * offers to clear them.
 */
export async function stagedParakeetBytes(version: ParakeetVersion): Promise<number> {
  if (!ParakeetASR.isAvailable()) return 0;
  const stagingDirectory = await stagingDirectoryUri(version);
  // getInfoAsync sums a directory's contents recursively on iOS.
  const [staging, marker] = await Promise.all([
    FileSystem.getInfoAsync(stagingDirectory),
    FileSystem.getInfoAsync(`${stagingDirectory}/${REVISION_MARKER}`),
  ]);
  if (!staging.exists) return 0;
  // The revision marker is bookkeeping, not progress worth keeping or clearing.
  return Math.max(staging.size - (marker.exists ? marker.size : 0), 0);
}
