import {
  CloudApiError,
  cloudGet,
  cloudGetForAuthGeneration,
  cloudPost,
  cloudPostForAuthGeneration,
} from "./cloudApi.js";

// Set once the account keeps its private notes on its devices: the server
// purges the cloud copies after purge_after.
export interface PrivateNotesOnDeviceState {
  on_device_since: string;
  purge_after: string;
}

export const PERSONAL_NOTES_CHANGED = "personal_notes_changed";

// The switch was refused: a personal note or folder changed in the cloud after
// pulled_through, so the pull that came before it missed something.
export class PersonalNotesChangedError extends Error {
  readonly code = PERSONAL_NOTES_CHANGED;

  constructor() {
    super("Private notes changed in the cloud after they were pulled");
    this.name = "PersonalNotesChangedError";
  }
}

export function isPrivateNotesOnDeviceState(value: unknown): value is PrivateNotesOnDeviceState {
  const state = value as Partial<PrivateNotesOnDeviceState> | null;
  return (
    typeof state === "object" &&
    state !== null &&
    typeof state.on_device_since === "string" &&
    typeof state.purge_after === "string"
  );
}

// A response's state: none, or a well-formed one.
function stateFrom(data: unknown): PrivateNotesOnDeviceState | null {
  if (data == null) return null;
  if (!isPrivateNotesOnDeviceState(data)) throw new Error("Malformed private notes state");
  return data;
}

const STATE_PATH = "/api/me/private-notes";
const SWITCH_PATH = "/api/me/private-notes/on-device";

// Given an auth generation, a call is pinned to that sign-in: main refuses it
// once the sign-in is replaced, so an import that outlives an account switch
// asks nothing of the next account.
async function getState(authGeneration?: number): Promise<{
  state: PrivateNotesOnDeviceState | null;
  serverTime: string;
}> {
  type StateResponse = { data?: unknown; server_time?: unknown };
  const res =
    authGeneration === undefined
      ? await cloudGet<StateResponse>(STATE_PATH)
      : await cloudGetForAuthGeneration<StateResponse>(STATE_PATH, authGeneration);
  const state = stateFrom(res?.data);
  if (typeof res?.server_time !== "string") throw new Error("Missing private notes server time");
  return { state, serverTime: res.server_time };
}

// pulledThrough is the server_time a state call returned, sent back as is: the
// server compares it with its own clock, which this device's can run ahead of.
async function switchOnDevice(
  pulledThrough: string,
  authGeneration?: number
): Promise<PrivateNotesOnDeviceState> {
  const body = { pulled_through: pulledThrough };
  let res: { data?: unknown };
  try {
    res =
      authGeneration === undefined
        ? await cloudPost<{ data?: unknown }>(SWITCH_PATH, body)
        : await cloudPostForAuthGeneration<{ data?: unknown }>(SWITCH_PATH, body, authGeneration);
  } catch (err) {
    if (err instanceof CloudApiError && err.code === PERSONAL_NOTES_CHANGED) {
      throw new PersonalNotesChangedError();
    }
    throw err;
  }
  const state = stateFrom(res?.data);
  if (!state) throw new Error("Malformed private notes state");
  return state;
}

export const PrivateNotesService = { getState, switchOnDevice };
