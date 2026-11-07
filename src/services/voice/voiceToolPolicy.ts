import type { ToolDefinition, ToolRegistry, ToolResult } from "../tools";

const VOICE_WEB_RESULTS = 3;
const VOICE_WEB_TEXT_CHARS = 240;
// Local writes a small model was seen repeating within one spoken turn. Sends
// to other people have their own duplicate guard (action keys).
const GUARDED_WRITES = new Set(["create_note", "update_note", "update_dictionary"]);
// A failed write changed nothing, so one retry can't duplicate anything; a
// second failure ends it so a failing tool can't loop.
const MAX_RUNS_AFTER_FAILURE = 2;
// The harness plays scripted turns into a real profile, so no write may change it.
// The model reads it as done: told that nothing changed, it retried with new wording.
const DRY_RUN_RESULT: ToolResult = {
  success: true,
  data: { dryRun: true, note: "Done. This test run simulates the change." },
  displayText: "Test run: nothing was changed.",
};

interface WebResult {
  title?: string;
  text?: string;
  publishedDate?: string | null;
}

// Five results with 500-character text and URLs cost ~1,100 prompt tokens
// (~1.5 s on a local 9B); three short ones without URLs, which can't be spoken
// anyway, cost about a quarter of that.
function compactWebResults(result: ToolResult): ToolResult {
  if (!result.success || !Array.isArray(result.data)) return result;
  return {
    ...result,
    data: (result.data as WebResult[]).slice(0, VOICE_WEB_RESULTS).map((item) => ({
      title: item.title || "",
      text: (item.text || "").slice(0, VOICE_WEB_TEXT_CHARS),
      publishedDate: item.publishedDate ?? null,
    })),
  };
}

const stableKey = (value: unknown): string =>
  JSON.stringify(value, (_key, field) =>
    field && typeof field === "object" && !Array.isArray(field)
      ? Object.fromEntries(Object.entries(field).sort(([a], [b]) => a.localeCompare(b)))
      : field
  );

function guardRepeats(tool: ToolDefinition): ToolDefinition {
  const calls = new Map<string, { result: Promise<ToolResult>; runs: number }>();
  const run = (key: string, execute: () => Promise<ToolResult>, runs: number) => {
    const result = execute();
    calls.set(key, { result, runs });
    return result;
  };
  return {
    ...tool,
    execute: async (args, context) => {
      const key = stableKey(args);
      const earlier = calls.get(key);
      if (!earlier) return run(key, () => tool.execute(args, context), 1);
      const first = await earlier.result.catch((error: Error): ToolResult => ({
        success: false,
        data: null,
        displayText: error.message,
      }));
      if (!first.success && earlier.runs < MAX_RUNS_AFTER_FAILURE) {
        return run(key, () => tool.execute(args, context), earlier.runs + 1);
      }
      // The model is told it wasn't run again, so it can't describe a repeat as a second write.
      return first.success
        ? {
            success: true,
            data: {
              notRunAgain: true,
              note: `This exact ${tool.name} call already ran in this turn and was not run again. Tell the user it was done once.`,
              result: first.data,
            },
            displayText: first.displayText,
          }
        : first;
    },
  };
}

interface VoiceToolOptions {
  /** The harness: every write answers with a canned success instead of running. */
  dryRunWrites?: boolean;
  /** Hears each write that runs; a repeat the guard blocks never runs. */
  onWriteRun?: (toolName: string, ok: boolean) => void;
}

/**
 * The tools of one spoken turn: web results cut to what speech can use, and
 * an identical local write (same tool, same arguments) runs once. Different
 * writes in one turn all run. The registry is built for this turn alone, so
 * the guard lasts exactly one turn.
 */
export function adaptToolsForVoice(
  registry: ToolRegistry,
  { dryRunWrites = false, onWriteRun }: VoiceToolOptions = {}
): void {
  for (const original of registry.getAll()) {
    let tool = original;
    if (!tool.readOnly && dryRunWrites) {
      tool = { ...tool, execute: async () => DRY_RUN_RESULT };
    }
    if (!tool.readOnly && onWriteRun) {
      const write = tool;
      tool = {
        ...write,
        execute: async (args, context) => {
          let ok = false;
          try {
            const result = await write.execute(args, context);
            ok = result.success;
            return result;
          } finally {
            onWriteRun(write.name, ok);
          }
        },
      };
    }
    if (tool.name === "web_search") {
      const search = tool;
      tool = {
        ...search,
        execute: async (args, context) => compactWebResults(await search.execute(args, context)),
      };
    } else if (GUARDED_WRITES.has(tool.name)) {
      tool = guardRepeats(tool);
    }
    if (tool !== original) registry.register(tool);
  }
}
