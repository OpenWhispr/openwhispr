import { CloudApiError, isAuthContextError } from "./cloudApi.js";
import {
  isPrivateNotesOnDeviceState,
  PersonalNotesChangedError,
  type PrivateNotesOnDeviceState,
} from "./PrivateNotesService";

export type PrivateNotesImportResult = "switched" | "already" | "failed";

// A run's outcome. "unsupported": the API has no private notes routes yet
// (404), which the next pass asks about again, with no wait.
export type PrivateNotesImportOutcome = PrivateNotesImportResult | "unsupported";

// How often a switch the server refused because notes changed meanwhile is
// tried again, each time after a fresh pull.
const PRIVATE_NOTES_SWITCH_RETRIES = 3;

const RETRY_FIRST_WAIT_MS = 5 * 60 * 1000;
const RETRY_LONGEST_WAIT_MS = 60 * 60 * 1000;

// After a failed run, an account's next waits (D29), so a run that keeps
// failing doesn't read the cloud's private notes on every pass. A new sign-in
// starts afresh.
export interface PrivateNotesImportWait {
  authGeneration: number;
  failures: number;
  retryAt: number;
}

// 5 minutes, twice as long after each further failure, an hour at most.
export function privateNotesImportRetryWait(failures: number): number {
  return Math.min(RETRY_FIRST_WAIT_MS * 2 ** (failures - 1), RETRY_LONGEST_WAIT_MS);
}

export function isWaitingToImport(
  wait: PrivateNotesImportWait | undefined,
  authGeneration: number,
  now: number
): boolean {
  return wait?.authGeneration === authGeneration && now < wait.retryAt;
}

// The wait a run's outcome leaves: none unless it failed.
export function nextImportWait(
  wait: PrivateNotesImportWait | undefined,
  authGeneration: number,
  outcome: PrivateNotesImportOutcome,
  now: number
): PrivateNotesImportWait | undefined {
  if (outcome !== "failed") return undefined;
  const failures = (wait?.authGeneration === authGeneration ? wait.failures : 0) + 1;
  return { authGeneration, failures, retryAt: now + privateNotesImportRetryWait(failures) };
}

const MARKER_PREFIX = "privateNotesOnDevice:";

// The server's state, kept per account once this device knows the account is
// switched, so later passes ask nothing. Storage that can't be read reads as
// unknown: the server is asked again, and an account it says is switched is
// never imported a second time.
function readPrivateNotesOnDevice(accountId: string): PrivateNotesOnDeviceState | null {
  try {
    const raw = localStorage.getItem(`${MARKER_PREFIX}${accountId}`);
    const state: unknown = raw ? JSON.parse(raw) : null;
    return isPrivateNotesOnDeviceState(state) ? state : null;
  } catch {
    return null;
  }
}

function rememberPrivateNotesOnDevice(accountId: string, state: PrivateNotesOnDeviceState): void {
  try {
    localStorage.setItem(`${MARKER_PREFIX}${accountId}`, JSON.stringify(state));
  } catch {
    // Unsaved, the next pass asks the server, which answers "already".
  }
}

export interface PrivateNotesImportSteps {
  // False once the sign-in that started the import is no longer the current one.
  isCurrent(): boolean;
  getState(): Promise<{ state: PrivateNotesOnDeviceState | null; serverTime: string }>;
  // Sends the deletes this device still owes the cloud, so the pull can't bring
  // those notes or folders back.
  pushDeletes(): Promise<void>;
  // Every personal folder, then every personal note, with no cursor. False
  // when anything was left out.
  pull(): Promise<boolean>;
  switchOnDevice(pulledThrough: string): Promise<PrivateNotesOnDeviceState>;
  onSwitched(state: PrivateNotesOnDeviceState): void;
}

/**
 * Brings an account's cloud private notes to this device once, then tells the
 * server the account keeps them on its devices; the server purges the cloud
 * copies 30 days later. Any failure leaves the server as it was and nothing
 * stored, so a later pass runs it again.
 */
export async function importCloudPrivateNotesOnce(
  accountId: string,
  steps: PrivateNotesImportSteps
): Promise<PrivateNotesImportOutcome> {
  if (readPrivateNotesOnDevice(accountId)) return "already";
  try {
    for (let retries = 0; ; retries++) {
      if (!steps.isCurrent()) return "failed";
      const { state, serverTime } = await steps.getState();
      if (state) {
        rememberPrivateNotesOnDevice(accountId, state);
        return "already";
      }
      // A delete that goes out here changes a note after serverTime, so the
      // switch below asks again once, with a fresh one. A sync pass has
      // usually sent them all already.
      await steps.pushDeletes();
      if (!(await steps.pull()) || !steps.isCurrent()) return "failed";
      try {
        const switched = await steps.switchOnDevice(serverTime);
        rememberPrivateNotesOnDevice(accountId, switched);
        steps.onSwitched(switched);
        return "switched";
      } catch (err) {
        if (!(err instanceof PersonalNotesChangedError)) throw err;
        if (retries >= PRIVATE_NOTES_SWITCH_RETRIES) return "failed";
      }
    }
  } catch (err) {
    // An API without the routes yet and an account switch fail quietly.
    if (err instanceof CloudApiError && err.status === 404) return "unsupported";
    if (!isAuthContextError(err)) console.error("Private notes import failed:", err);
    return "failed";
  }
}
