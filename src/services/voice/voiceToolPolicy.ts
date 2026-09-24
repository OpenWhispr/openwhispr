/**
 * Mishearings turned "read back my snippet" into snippet edits and deletions in
 * the harness, so voice turns can't edit snippets; typed chat still can.
 */
export const VOICE_EXCLUDED_TOOLS: readonly string[] = ["update_snippets"];

const ALREADY_DONE_NOTE =
  "This action already ran in this turn. Don't repeat it; tell the user what was done.";

const isToolError = (result: unknown): boolean =>
  typeof result === "object" && result !== null && "error" in result;

export interface WriteOnceGuard {
  run(name: string, execute: () => Promise<unknown>): Promise<unknown>;
}

/**
 * Small local models repeated create_note / update_note within one turn, which
 * would write duplicates. Each write tool runs at most once per voice turn; a
 * repeat call gets the first result back instead of running again.
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
        return previous.then((result) => ({ alreadyDone: true, note: ALREADY_DONE_NOTE, result }));
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
 * shape the guard above reads. A failed write still reports `ok: false`, and a
 * repeat call comes back as a successful result whose data is the "already
 * ran" note, so the cloud executor can serialize it like any other tool
 * result.
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
    return { success: true, data: raw.note, displayText: raw.note };
  }
  const { error: _unused, ...rest } = raw as ToolResultLike & { error?: string };
  return rest;
}
