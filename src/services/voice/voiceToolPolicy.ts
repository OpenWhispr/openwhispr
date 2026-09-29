/**
 * Mishearings turned "read back my snippet" into snippet edits and deletions in
 * the harness, so voice turns can't edit snippets; typed chat still can.
 */
export const VOICE_EXCLUDED_TOOLS: readonly string[] = ["update_snippets"];

// A two-item request ("make two notes") hits the guard on the second item; telling the
// model "what was done" made it describe the blocked write as done too.
const notRunNote = (name: string): string =>
  `A second ${name} call in this turn was NOT run. Tell the user only the first one was done, and to ask for the next one separately.`;

const isToolError = (result: unknown): boolean =>
  typeof result === "object" && result !== null && "error" in result;

// A repeat call after a FAILED write must not read as a plain success, or the model
// goes on to tell the user the write worked. The error text comes from the AI-SDK
// { error } shape isToolError above reads.
const errorTextOf = (result: unknown): string => {
  const error = (result as { error?: unknown } | null)?.error;
  return typeof error === "string" ? error : "unknown error";
};

const alreadyFailedNote = (errorText: string): string =>
  `This action already failed in this turn: ${errorText}. Don't retry; tell the user it didn't work.`;

// A failed write created nothing, so one retry (e.g. with a corrected note id) can't
// duplicate anything; a second failure ends it so a failing tool can't loop.
const MAX_RUNS_AFTER_FAILURE = 2;

export interface WriteOnceGuard {
  run(name: string, execute: () => Promise<unknown>): Promise<unknown>;
}

interface WriteState {
  /** Calls to one tool settle in order, so each sees the outcome of the one before. */
  tail: Promise<unknown>;
  runs: number;
  lastResult: unknown;
}

/**
 * Small local models repeated create_note / update_note within one turn, which
 * would write duplicates. Each write tool runs once per voice turn, plus one retry
 * if that run failed. Any other repeat gets the last result back instead of
 * running, with a note that it was NOT run, or that the write failed.
 */
export function createWriteOnceGuard(
  writeToolNames: ReadonlySet<string>,
  onWriteResult?: (name: string, ok: boolean) => void
): WriteOnceGuard {
  const states = new Map<string, WriteState>();
  const execOnce = async (name: string, state: WriteState, execute: () => Promise<unknown>) => {
    state.runs += 1;
    try {
      state.lastResult = await execute();
    } catch (error) {
      state.lastResult = { error: (error as Error)?.message || String(error) };
      onWriteResult?.(name, false);
      throw error;
    }
    onWriteResult?.(name, !isToolError(state.lastResult));
    return state.lastResult;
  };
  return {
    run(name, execute) {
      if (!writeToolNames.has(name)) return execute();
      const state = states.get(name) ?? { tail: Promise.resolve(), runs: 0, lastResult: undefined };
      states.set(name, state);
      const call = state.tail.then(() => {
        if (state.runs === 0) return execOnce(name, state, execute);
        const failed = isToolError(state.lastResult);
        if (failed && state.runs < MAX_RUNS_AFTER_FAILURE) return execOnce(name, state, execute);
        const note = failed ? alreadyFailedNote(errorTextOf(state.lastResult)) : notRunNote(name);
        return { alreadyDone: true, note, result: state.lastResult };
      });
      state.tail = call.catch(() => {});
      return call;
    },
  };
}

/** The shape OpenWhispr Cloud's tool-call path executes tools against (ToolRegistry.execute). */
export interface ToolResultLike {
  success: boolean;
  data: unknown;
  displayText: string;
  /** A repeat the guard didn't run; `data` carries its note to the model. */
  blocked?: boolean;
}

/** Whether a guarded call was a repeat that didn't run (see createWriteOnceGuard). */
export const isBlockedRepeat = (
  value: unknown
): value is { alreadyDone: true; note: string; result: unknown } =>
  typeof value === "object" &&
  value !== null &&
  (value as { alreadyDone?: unknown }).alreadyDone === true;

/**
 * Adapts createWriteOnceGuard for the OpenWhispr Cloud tool-call path, which
 * executes tools directly (executeTool(registry.get(name), args, context)) and gets back a
 * ToolResult ({ success, data, displayText }) rather than the AI-SDK { error }
 * shape the guard above reads. A failed write still reports `ok: false`. A
 * repeat call never claims success on a write that actually failed: its
 * `success` matches the first run's outcome, `data` carries the guard's note
 * (for the model), and `displayText` reuses the first run's displayText (for
 * the chat UI) rather than the English model-facing note.
 */
export async function runToolResultOnce(
  guard: WriteOnceGuard,
  name: string,
  execute: () => Promise<ToolResultLike>
): Promise<ToolResultLike> {
  const raw = await guard.run(name, async () => {
    const result = await execute();
    return result.success ? result : { ...result, error: result.displayText };
  });

  if (isBlockedRepeat(raw)) {
    const firstResult = raw.result as ToolResultLike & { error?: string };
    return {
      success: !isToolError(firstResult),
      data: raw.note,
      displayText: firstResult.displayText,
      blocked: true,
    };
  }
  const { error: _unused, ...rest } = raw as ToolResultLike & { error?: string };
  return rest;
}
