/**
 * Mishearings turned "read back my snippet" into snippet edits and deletions in
 * the harness, so voice turns can't edit snippets; typed chat still can.
 */
export const VOICE_EXCLUDED_TOOLS: readonly string[] = ["update_snippets"];

// R14: a two-item request ("make two notes") hits the guard on the second item; telling the
// model "what was done" made it describe the blocked write as done too.
const notRunNote = (name: string): string =>
  `A second ${name} call in this turn was NOT run. Tell the user only the first one was done, and to ask for the next one separately.`;

const isToolError = (result: unknown): boolean =>
  typeof result === "object" && result !== null && "error" in result;

// R8: a repeat call after a FAILED first write must not read as a plain success —
// the model would go on to tell the user the write succeeded. The error text comes
// from the AI-SDK { error } shape isToolError above reads.
const errorTextOf = (result: unknown): string => {
  const error = (result as { error?: unknown } | null)?.error;
  return typeof error === "string" ? error : "unknown error";
};

const alreadyFailedNote = (errorText: string): string =>
  `This action already failed in this turn: ${errorText}. Don't retry; tell the user it didn't work.`;

export interface WriteOnceGuard {
  run(name: string, execute: () => Promise<unknown>): Promise<unknown>;
}

/**
 * Small local models repeated create_note / update_note within one turn, which
 * would write duplicates. Each write tool runs at most once per voice turn; a
 * repeat call gets the first result back instead of running again, with a note
 * that it was NOT run (R14). If the first run failed, the note says so instead of
 * claiming success (R8).
 */
export function createWriteOnceGuard(
  writeToolNames: ReadonlySet<string>,
  onWriteResult?: (name: string, ok: boolean) => void
): WriteOnceGuard {
  const firstRuns = new Map<string, Promise<unknown>>();
  return {
    run(name, execute) {
      if (!writeToolNames.has(name)) return execute();
      const previous = firstRuns.get(name);
      if (previous) {
        return previous.then((result) =>
          isToolError(result)
            ? { alreadyDone: true, note: alreadyFailedNote(errorTextOf(result)), result }
            : { alreadyDone: true, note: notRunNote(name), result }
        );
      }
      const pending = execute().then((result) => {
        onWriteResult?.(name, !isToolError(result));
        return result;
      });
      firstRuns.set(name, pending);
      return pending;
    },
  };
}

/** The shape OpenWhispr Cloud's tool-call path executes tools against (ToolRegistry.execute). */
export interface ToolResultLike {
  success: boolean;
  data: unknown;
  displayText: string;
}

const isAlreadyDoneResult = (
  value: unknown
): value is { alreadyDone: true; note: string; result: unknown } =>
  typeof value === "object" && value !== null && (value as { alreadyDone?: unknown }).alreadyDone === true;

/**
 * Adapts createWriteOnceGuard for the OpenWhispr Cloud tool-call path, which
 * executes tools directly (registry.get(name).execute(args)) and gets back a
 * ToolResult ({ success, data, displayText }) rather than the AI-SDK { error }
 * shape the guard above reads. A failed write still reports `ok: false`. A
 * repeat call never claims success on a write that actually failed (R8): its
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

  if (isAlreadyDoneResult(raw)) {
    const firstResult = raw.result as ToolResultLike & { error?: string };
    return {
      success: !isToolError(firstResult),
      data: raw.note,
      displayText: firstResult.displayText,
    };
  }
  const { error: _unused, ...rest } = raw as ToolResultLike & { error?: string };
  return rest;
}
