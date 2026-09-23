import { resolvePrompt } from "./prompts/index";

export {
  resolvePrompt,
  getDefaultPromptText,
  appendDictionarySuffix,
  appendScreenContextSuffix,
  wrapCleanupTranscript,
} from "./prompts/index";
export { PROMPT_KINDS, PROMPT_KIND_LIST, type PromptKind } from "./prompts/registry";
export { detectAgentName } from "./agentDetection";

export function getCleanupSystemPrompt(
  agentName: string | null,
  customDictionary?: string[],
  language?: string,
  uiLanguage?: string
): string {
  return resolvePrompt("cleanup", { agentName, language, customDictionary, uiLanguage });
}

export function getWordBoost(customDictionary?: string[]): string[] {
  if (!customDictionary || customDictionary.length === 0) return [];
  return customDictionary.filter((w) => w.trim());
}

const TOOL_INSTRUCTIONS: Record<string, string> = {
  search_notes:
    "Use search_notes to find information from the user's past meetings, discussions, or personal notes before answering from memory.",
  get_note:
    "Use get_note to fetch the full content of a specific note by ID. If the current note's ID is provided in the context, use it directly. Otherwise, use search_notes first to find the note ID.",
  create_note:
    "Use create_note when the user asks you to create, write, or draft a new note. Whenever the note will go into a folder, call list_folders first and reuse an existing folder whose name is a reasonable fit for the note's topic (e.g. a new story belongs in an existing 'Stories' folder) — do this even when the user didn't name a folder but the content clearly fits one. Only pass a new folder name when nothing existing fits. Be tolerant of case, plurals, and typos.",
  update_note:
    "Use update_note to modify an existing note's title, content, or move it to a different folder. If the current note's ID is provided in the context, use it directly. Otherwise, use search_notes first to find the note ID. When moving to a folder, call list_folders first and reuse an existing folder whose name fits the note's topic; only create a new folder when nothing existing fits.",
  list_folders:
    "Use list_folders before create_note or update_note whenever a note is going into a folder, so you can reuse an existing folder whose name fits the note's topic instead of creating a near-duplicate.",
  web_search:
    "Use web_search for questions about current events, facts you're unsure about, or anything requiring up-to-date information.",
  copy_to_clipboard:
    "Use copy_to_clipboard when the user asks you to copy something to their clipboard.",
  get_snippet:
    "Use get_snippet whenever the user names one of their saved snippets or asks to insert, use, send, or read back saved text; match the trigger even if speech transcribed it slightly differently, and reproduce the returned text verbatim.",
  update_snippets:
    "Use update_snippets when the user asks to create, change, or delete a snippet (a spoken trigger that expands into saved text). If the user did not state both the trigger and the full replacement text, ask before saving.",
  update_dictionary:
    "Use update_dictionary when the user asks to add, remove, or fix the spelling of words in their custom dictionary; the current words are listed under Custom Dictionary. When asked to clean up the dictionary, list the exact removals you propose (duplicates, misspellings, casing variants, ordinary words) and wait for confirmation before removing anything the user did not name.",
  get_calendar_events:
    "Use get_calendar_events to check the user's schedule, upcoming meetings, or calendar events.",
  get_calendar_availability:
    "Use get_calendar_availability when the user asks when they are free or requests open time slots. Pass timezone-aware RFC3339 start and end timestamps, deriving the correct offset for each future date from the IANA time zone rather than assuming the current offset across a daylight-saving transition. Treat the returned slotCount and each slot's localized date, weekday, times, and duration as authoritative: use them exactly and never recalculate, add, omit, merge, or invent slots. For a broad multi-day request without daily-hour bounds, ask which hours of each day to consider, then make a separate call for each day. Results reflect the local calendar cache across the user's selected connected calendars, so describe free results as no scheduled conflicts found rather than guaranteed real-time availability, and never infer event details from availability facts.",
};

const twoDigits = (value: number): string => String(value).padStart(2, "0");

function formatLocalRfc3339(date: Date): string {
  const offsetMinutes = -date.getTimezoneOffset();
  const offsetSign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteOffset = Math.abs(offsetMinutes);
  const offset = `${offsetSign}${twoDigits(Math.floor(absoluteOffset / 60))}:${twoDigits(absoluteOffset % 60)}`;
  return (
    `${date.getFullYear()}-${twoDigits(date.getMonth() + 1)}-${twoDigits(date.getDate())}` +
    `T${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}:${twoDigits(date.getSeconds())}${offset}`
  );
}

function getLocalCalendarContext(): string {
  const now = new Date();
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  return `Current local date and time: ${formatLocalRfc3339(now)}. IANA time zone: ${timeZone}.`;
}

export interface AgentSystemPromptParts {
  /** Identical from turn to turn, so a local model's prompt cache can reuse it. */
  stable: string;
  /** Changes every turn: the clock and retrieved notes. Empty when there is none. */
  turnContext: string;
}

export function getAgentSystemPromptParts(
  availableTools?: string[],
  noteContext?: string
): AgentSystemPromptParts {
  let stable = resolvePrompt("chatAgent", { agentName: null });
  const turnContext: string[] = [];

  if (availableTools && availableTools.length > 0) {
    const toolLines = availableTools.map((name) => TOOL_INSTRUCTIONS[name]).filter(Boolean);
    if (toolLines.length > 0) {
      stable += "\n\nYou have access to tools. " + toolLines.join(" ");
    }
    if (availableTools.includes("get_calendar_availability")) {
      turnContext.push(getLocalCalendarContext());
    }
  }

  if (noteContext) {
    turnContext.push(
      "Below are notes from the user's library that may be relevant. " +
        "Reference them naturally if they help answer the question.\n\n" +
        noteContext
    );
  }

  return { stable, turnContext: turnContext.join("\n\n") };
}

export function getAgentSystemPrompt(availableTools?: string[], noteContext?: string): string {
  const { stable, turnContext } = getAgentSystemPromptParts(availableTools, noteContext);
  return turnContext ? `${stable}\n\n${turnContext}` : stable;
}

// Voice spike: English-only for now; move into prompts.json per locale before shipping.
// A stricter "one sentence, then stop" version cut tool recall from 9/10 to 5-7/10
// in the spike eval without shortening answers; spoken length is capped in code instead.
const VOICE_BREVITY =
  "Your reply will be spoken aloud in a live voice conversation. Answer in one or two short " +
  "sentences unless the user asks for more. Never use Markdown, lists, tables, headings, " +
  "code, URLs, or emoji. Write numbers, times, and dates the way a person would say them.";

/**
 * Spoken-reply rules, with tool guidance first: brevity alone made the local
 * model answer from memory (2/10 tool use in the spike eval vs 9/10 with this).
 */
export function getVoiceReplyInstructions(availableTools: string[] = []): string {
  const has = (name: string) => availableTools.includes(name);
  const uses: string[] = [];
  if (has("web_search")) {
    uses.push("for anything current, time-sensitive, or that you don't know for certain, call web_search");
  }
  if (has("search_notes")) uses.push("for the user's own meetings or notes, call search_notes");
  if (has("get_calendar_events") || has("get_calendar_availability")) {
    uses.push("for their schedule, use the calendar tools");
  }
  if (uses.length === 0) return VOICE_BREVITY;

  let guidance =
    `Use your tools before answering whenever they could help: ${uses.join("; ")}. ` +
    "Never tell the user you can't find or don't know something without first trying the relevant tool. " +
    "Notes provided as context are only possibly relevant; if they don't answer the question, use a tool.";
  if (has("web_search")) {
    guidance +=
      " Your built-in knowledge may be out of date, so for anything about the latest, current, " +
      "today, now, prices, news, weather, sports results, schedules, or releases, always call " +
      "web_search rather than answering from memory.";
  }
  guidance += " When you decide to use a tool, call it in the same response; never just say that you will check.";
  return `${guidance}\n\n${VOICE_BREVITY}`;
}

/**
 * Voice turns carry the per-turn context (clock, retrieved notes) in the user's
 * message instead of the system prompt, so everything before it stays cacheable.
 */
export function buildVoiceTurnMessage(userText: string, turnContext: string): string {
  if (!turnContext) return userText;
  return `Context for this turn:\n${turnContext}\n\nThe user said: ${userText}`;
}
