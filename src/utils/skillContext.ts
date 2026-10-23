import { estimateNoteTokens, planNoteChunks } from "../helpers/noteChunking";
import { HISTORY_LIMIT } from "../components/chat/historyMessages";
import type { Message } from "../components/chat/types";
import type { SkillForModel, SkillRef, SkillSummary } from "../types/skills";

/** The skills list in the system prompt: about 2% of a hosted model's context, or a 16k local one's. */
export const SKILL_CATALOG_MAX_TOKENS = { hosted: 2_000, selfHosted: 330 } as const;
/** The text of the skills one turn uses. */
export const SKILL_CONTEXT_MAX_TOKENS = { hosted: 16_000, selfHosted: 2_500 } as const;
export type SkillTier = keyof typeof SKILL_CONTEXT_MAX_TOKENS;

const SCRIPTS_NOTE = "scripts are shown to the user to run, never run by you";
const SKILL_CUT = "[The rest of this skill was cut to fit.]";
const FILE_CUT = "[The rest of this file was cut to fit.]";
// Each list of file names gets at most this share of a skill's budget, so a skill with
// hundreds of files can't push its own instructions out.
const FILE_NAMES_SHARE = 8;
// A description in the skills list says when to use the skill; past this it is cut.
const CATALOG_DESCRIPTION_MAX_CHARS = 300;

// Each letter as written, or its full-width form, in either case.
const anyWidth = (word: string): string =>
  [...word].map((char) => `[${char}${String.fromCharCode(char.charCodeAt(0) + 0xfee0)}]`).join("");
// A tag that opens or closes one of the blocks skill text is fenced in, however it is written:
// any case, spaced out, or with full-width or small look-alike brackets.
const FENCE_TAG = new RegExp(
  `[<\uff1c\ufe64](?=\\s*[/\uff0f]?\\s*${anyWidth("skill")}[\\s_\uff3f-]*(?:${[
    "content",
    "file",
    "catalog",
  ]
    .map(anyWidth)
    .join("|")}))`,
  "giu"
);

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();
// A skill's text is data: no tag inside it may end its block early or open another.
const asData = (text: string): string => text.replace(FENCE_TAG, "&lt;").trimEnd();
const asAttribute = (text: string): string => asData(oneLine(text)).replace(/"/g, "&quot;");
const catalogDescription = (text: string): string => {
  const chars = [...asData(oneLine(text))];
  return chars.length > CATALOG_DESCRIPTION_MAX_CHARS
    ? `${chars.slice(0, CATALOG_DESCRIPTION_MAX_CHARS).join("").trimEnd()}…`
    : chars.join("");
};
const lastUse = (skill: SkillSummary): string => skill.lastUsedAt ?? "";

// The leading whole lines of `text` that fit, marked when cut. One token stays free for the
// line break before the marker.
function cutToFit(text: string, maxTokens: number, marker: string): string {
  if (estimateNoteTokens(text) <= maxTokens) return text;
  const room = maxTokens - estimateNoteTokens(marker) - 1;
  const kept = room > 0 ? (planNoteChunks(text, room)[0] ?? "") : "";
  return kept ? `${kept}\n${marker}` : marker;
}

// The paths that fit in `maxTokens`, then how many more there are.
function namesToFit(paths: string[], maxTokens: number): string {
  let used = 0;
  let shown = 0;
  for (const path of paths) {
    used += estimateNoteTokens(`${path}, `);
    if (used > maxTokens) break;
    shown += 1;
  }
  const names = paths.slice(0, shown).join(", ");
  const rest = paths.length - shown;
  if (rest === 0) return names;
  return shown > 0 ? `${names} and ${rest} more` : `${rest} files`;
}

function filesLine(files: SkillForModel["files"], inlineFiles: boolean, maxTokens: number): string {
  if (files.length === 0) return "";
  const note = inlineFiles
    ? SCRIPTS_NOTE
    : `read one with load_skill and its file; ${SCRIPTS_NOTE}`;
  const names = namesToFit(
    files.map((file) => file.path),
    maxTokens
  );
  return `Files: ${names} (${note})`;
}

const fileBlock = (file: SkillForModel["files"][number]): string =>
  `<skill_file path="${asAttribute(file.path)}">\n${asData(file.content ?? "")}\n</skill_file>`;

/**
 * One line per skill, most recently used first, fenced as data: descriptions can come from an
 * uploaded skill. Past the budget the least-used lose their descriptions, but every name stays.
 */
export function buildSkillCatalog(skills: SkillSummary[], maxTokens: number): string {
  const ordered = [...skills].sort((a, b) =>
    lastUse(a) < lastUse(b) ? 1 : lastUse(a) > lastUse(b) ? -1 : 0
  );
  const lines = ordered.map((skill) => `- ${skill.name}: ${catalogDescription(skill.description)}`);
  const fenced = (): string => ["<skill_catalog>", ...lines, "</skill_catalog>"].join("\n");
  for (
    let index = lines.length - 1;
    index >= 0 && estimateNoteTokens(fenced()) > maxTokens;
    index -= 1
  ) {
    lines[index] = `- ${ordered[index].name}`;
  }
  return fenced();
}

/**
 * A skill's instructions as data for the model. Inline files (for a model without tools) are
 * cut first, then the instructions, and either cut is marked.
 */
export function buildSkillBlock(
  skill: SkillForModel,
  maxTokens: number,
  options: { inlineFiles: boolean }
): string {
  return fitSkillBlock(skill, maxTokens, options).text;
}

/** buildSkillBlock, and whether its instructions or inline files were cut to fit. */
export function fitSkillBlock(
  skill: SkillForModel,
  maxTokens: number,
  { inlineFiles }: { inlineFiles: boolean }
): { text: string; cut: boolean } {
  const open = `<skill_content name="${asAttribute(skill.name)}" title="${asAttribute(skill.displayName)}">`;
  const namesBudget = Math.floor(maxTokens / FILE_NAMES_SHARE);
  const close = ["</skill_content>", filesLine(skill.files, inlineFiles, namesBudget)]
    .filter(Boolean)
    .join("\n");
  const inline = inlineFiles ? skill.files.filter((file) => file.content !== undefined) : [];
  const render = (body: string, included: number): string => {
    const leftOut = inline.slice(included).map((file) => file.path);
    return [
      open,
      body,
      ...inline.slice(0, included).map(fileBlock),
      ...(leftOut.length > 0 ? [`[Left out to fit: ${namesToFit(leftOut, namesBudget)}]`] : []),
      close,
    ].join("\n");
  };

  const body = asData(skill.body);
  const fitted = cutToFit(body, maxTokens - estimateNoteTokens(render("", 0)), SKILL_CUT);
  if (fitted !== body) return { text: render(fitted, 0), cut: true };
  let included = 0;
  while (included < inline.length && estimateNoteTokens(render(body, included + 1)) <= maxTokens) {
    included += 1;
  }
  return { text: render(body, included), cut: included < inline.length };
}

/**
 * What the built-in skill creator needs to know: the question the chat opened with (shown, never
 * saved), the user's skills, their apps, tool use.
 */
export function buildCreatorContext(
  skills: SkillSummary[],
  connectedApps: string[],
  { canUseTools, maxTokens, opening }: { canUseTools: boolean; maxTokens: number; opening: string }
): string {
  return [
    `The chat opened by asking the user: "${opening}"`,
    skills.length > 0
      ? `The user's skills (name: when to use it):\n${buildSkillCatalog(skills, maxTokens)}`
      : "The user has no skills yet.",
    `Connected apps: ${connectedApps.length > 0 ? connectedApps.join(", ") : "none"}`,
    ...(canUseTools ? [] : ["This model can't call tools."]),
  ].join("\n");
}

/** One file of a skill, read with load_skill. */
export function buildSkillFileBlock(skill: SkillForModel, path: string, maxTokens: number): string {
  const content = asData(skill.files.find((file) => file.path === path)?.content ?? "");
  const render = (text: string): string =>
    `<skill_file skill="${asAttribute(skill.name)}" path="${asAttribute(path)}">\n${text}\n</skill_file>`;
  return render(cutToFit(content, maxTokens - estimateNoteTokens(render("")), FILE_CUT));
}

/** What a load_skill call asked for: a skill by name, whole or one of its files. */
export function loadSkillTarget(argumentsJson: string): { name: string; file: boolean } | null {
  try {
    const args = JSON.parse(argumentsJson);
    return typeof args?.name === "string" ? { name: args.name, file: Boolean(args.file) } : null;
  } catch {
    return null;
  }
}

/**
 * The skills a turn uses: the attached one, then those load_skill read in the history the
 * model sees, newest first, so a full budget leaves out the oldest.
 */
export function activeSkillNames(history: Message[], attached?: SkillRef): SkillRef[] {
  const active: SkillRef[] = attached ? [attached] : [];
  const seen = new Set(attached && !attached.builtin ? [attached.name] : []);
  for (const message of history.slice(-HISTORY_LIMIT).reverse()) {
    for (const call of [...(message.toolCalls ?? [])].reverse()) {
      if (call.name !== "load_skill" || call.status !== "completed") continue;
      const target = loadSkillTarget(call.arguments);
      if (!target || target.file || seen.has(target.name)) continue;
      seen.add(target.name);
      active.push({ name: target.name });
    }
  }
  return active;
}

/** The latest user turn as only the model sees it: the skills first, then the request. */
export function withSkillContext(userText: string, blocks: string[]): string {
  return [...blocks, "", "User request:", userText].join("\n");
}
