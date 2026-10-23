import { buildSkillBlock, buildSkillFileBlock } from "../../utils/skillContext";
import { requestSkillApproval, type SkillApprovalOutcome } from "../../stores/skillApprovalStore";
import type {
  SkillForModel,
  SkillProposal,
  SkillRef,
  SkillSummary,
  SkillUpdate,
} from "../../types/skills";
import type { ToolDefinition, ToolResult } from "./ToolRegistry";

const SKILL_CARD_SLOT = "skill_card";
const MAX_SKILL_CARDS_PER_ANSWER = 3;
const MAX_PROPOSAL_FILES = 20;

export interface SkillToolDeps {
  /** The user's skills that are switched on and valid; no other skill is ever read. */
  usable: SkillSummary[];
  /** Skills whose text this turn already carries. A getter: the registry outlives a send. */
  activeNames: () => ReadonlySet<string>;
  read: (ref: SkillRef & { file?: string }) => Promise<SkillForModel | null>;
  markUsed: (name: string) => void;
  /** What one load may hand the model, in estimated tokens. */
  maxTokens: number;
}

const failure = (displayText: string): ToolResult => ({ success: false, data: null, displayText });

export function createLoadSkillTool({
  usable,
  activeNames,
  read,
  markUsed,
  maxTokens,
}: SkillToolDeps): ToolDefinition {
  return {
    name: "load_skill",
    description:
      "Load one of the user's saved skills to follow it for the current request. When a request fits a skill, call this before asking the user a follow-up question. Pass file to read one of the files a loaded skill lists.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          enum: usable.map((skill) => skill.name),
          description: "The skill's name, exactly as listed",
        },
        file: {
          type: "string",
          description: "Optional: a file the skill lists, such as references/examples.md",
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
    readOnly: true,

    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const name = typeof args.name === "string" ? args.name : "";
      const file = typeof args.file === "string" && args.file ? args.file : undefined;
      const skill = usable.find((entry) => entry.name === name);
      if (!skill) return failure(`No skill named "${name}"`);
      if (!file && activeNames().has(name)) {
        return {
          success: true,
          data: `The ${name} skill is already loaded in this conversation. Follow it as given.`,
          displayText: skill.displayName,
        };
      }
      const loaded = await read(file ? { name, file } : { name });
      if (!loaded) {
        return failure(
          file
            ? `The ${name} skill has no file ${file} to read`
            : `The ${name} skill couldn't be read`
        );
      }
      markUsed(name);
      // A string, never an object: object results are saved with the chat as tool metadata.
      const data = file
        ? buildSkillFileBlock(loaded, file, maxTokens)
        : buildSkillBlock(loaded, maxTokens, { inlineFiles: false });
      return { success: true, data, displayText: skill.displayName };
    },
  };
}

const asText = (value: unknown): string => (typeof value === "string" ? value : "");

const HINTS = {
  proposeDescription: "What the skill does and when to use it, in one or two sentences",
  proposeInstructions: "The skill's instructions, as short headed sections",
  updateDescription: "The new description, if it changes",
  updateInstructions: "The full new instructions, if they change",
};
// A small model can send a field's own hint back as its value, which says nothing.
const givenText = (value: unknown, hint: string): string | undefined =>
  typeof value === "string" && value.trim().toLowerCase() !== hint.toLowerCase()
    ? value
    : undefined;

const FILES_PARAMETER = {
  type: "array",
  maxItems: MAX_PROPOSAL_FILES,
  items: {
    type: "object",
    properties: { path: { type: "string" }, content: { type: "string" } },
    required: ["path", "content"],
    additionalProperties: false,
  },
};

const problemsText = (codes: string, tool: string): string =>
  `Not proposed: ${codes}. Fix these and call ${tool} again. Don't mention them to the user.`;

function proposedFiles(value: unknown): SkillProposal["files"] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((file) => typeof file?.path === "string" && typeof file?.content === "string")
    .map((file: { path: string; content: string }) => ({ path: file.path, content: file.content }));
}

function outcomeText(outcome: SkillApprovalOutcome, done: "Saved" | "Updated"): string {
  switch (outcome.state) {
    case "saved":
      return `${done} the ${outcome.name} skill. Tell the user it's ${done.toLowerCase()} and how it's used.${
        outcome.edited ? " The user edited it before saving." : ""
      }`;
    case "skipped":
      return "The user skipped it. Nothing was saved.";
    case "failed":
      return "It couldn't be saved. Say so and offer to try again.";
    case "changed":
      return "Nothing was saved: the skill changed after the card was made. Say so, and load the skill again before proposing the change again.";
    case "not_saved":
      return "Nothing was saved.";
  }
}

export function createProposeSkillTool(): ToolDefinition {
  return {
    name: "propose_skill",
    description:
      "Propose a new skill for the user to save. Use it only when the user wants to make a skill. The user approves it on a card; nothing is saved before that.",
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          maxLength: 80,
          description: "Short and plain, such as Follow-up email from notes",
        },
        description: {
          type: "string",
          description: HINTS.proposeDescription,
        },
        instructions: {
          type: "string",
          description: HINTS.proposeInstructions,
        },
        files: {
          ...FILES_PARAMETER,
          description: "Optional files, such as references/examples.md",
        },
      },
      required: ["title", "description", "instructions"],
      additionalProperties: false,
    },
    readOnly: false,

    async execute(args: Record<string, unknown>, context): Promise<ToolResult> {
      if (!context) return failure("A skill can only be proposed in a chat");
      if (!context.claimTurnSlot(SKILL_CARD_SLOT, MAX_SKILL_CARDS_PER_ANSWER)) {
        return failure("Only three skill cards per answer.");
      }
      const proposal: SkillProposal = {
        title: asText(args.title),
        description: givenText(args.description, HINTS.proposeDescription) ?? "",
        instructions: givenText(args.instructions, HINTS.proposeInstructions) ?? "",
        files: proposedFiles(args.files),
      };
      const check = await window.electronAPI
        ?.skillsCheckProposal?.({ kind: "create", proposal })
        .catch(() => null);
      if (!check || !("problems" in check)) {
        context.releaseTurnSlot(SKILL_CARD_SLOT);
        return failure("The skill couldn't be checked");
      }
      // Problems go back to the model to fix; the user only ever sees a proposal that holds.
      if (check.problems.length > 0) {
        context.releaseTurnSlot(SKILL_CARD_SLOT);
        const codes = check.problems.map((problem) => problem.code).join(", ");
        return { success: true, data: problemsText(codes, "propose_skill"), displayText: "" };
      }
      const outcome = await requestSkillApproval(context, {
        kind: "create",
        name: check.name,
        replacesExisting: check.existing,
        baseHash: check.hash,
        draft: proposal,
      });
      // The card stands in for the step, so the step has no text of its own.
      return { success: true, data: outcomeText(outcome, "Saved"), displayText: "" };
    },
  };
}

// As main matches a changed file to the one it replaces: a leading "./" dropped, case ignored.
const withoutDotSlash = (path: string): string => path.replace(/^\.\//, "");
const pathKey = (path: string): string => withoutDotSlash(path).normalize("NFC").toLowerCase();

// The text the card diffs against: the instructions, and each file the change touches. A file
// the change replaces takes that file's path, so the card shows the change main will write.
async function currentText(skill: SkillSummary, changed: SkillUpdate["files"]) {
  const read = (ref: SkillRef & { file?: string; withFiles?: boolean }) =>
    window.electronAPI?.skillsReadForModel?.(ref).catch(() => null) ?? Promise.resolve(null);
  const loaded = await read({ name: skill.name, withFiles: true });
  if (!loaded) return null;
  const files: SkillUpdate["files"] = [];
  const currentFiles: Record<string, string> = {};
  for (const file of changed) {
    const listed = loaded.files.find((entry) => pathKey(entry.path) === pathKey(file.path));
    const path = listed?.path ?? withoutDotSlash(file.path);
    files.push({ path, content: file.content });
    // A file the change adds has no current text, and its diff is all additions.
    if (!listed?.text) continue;
    const content =
      listed.content ??
      (await read({ name: skill.name, file: path }))?.files.find((entry) => entry.path === path)
        ?.content;
    if (content !== undefined) currentFiles[path] = content;
  }
  return {
    files,
    current: { description: skill.description, instructions: loaded.body, files: currentFiles },
  };
}

async function learnedFromNote(id: unknown) {
  if (typeof id !== "number" || !Number.isInteger(id)) return null;
  const note = await window.electronAPI?.getNote?.(id).catch(() => null);
  return note ? { title: note.title, createdAt: note.created_at } : null;
}

export function createUpdateSkillTool(usable: SkillSummary[]): ToolDefinition {
  return {
    name: "update_skill",
    description:
      "Propose one change to a user's skill. Combine every change for that skill into one call. The user approves it on a card; nothing changes before that.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          enum: usable.map((skill) => skill.name),
          description: "The skill's name, exactly as listed",
        },
        intent: { type: "string", description: "One line: what changes and why" },
        removals: {
          type: "array",
          maxItems: 5,
          items: { type: "string" },
          description: "What the change removes, in plain words",
        },
        learned_from_note_id: {
          type: "integer",
          description: "The note this change was learned from, if any",
        },
        description: { type: "string", description: HINTS.updateDescription },
        instructions: { type: "string", description: HINTS.updateInstructions },
        files: { ...FILES_PARAMETER, description: "The full new text of each file it changes" },
      },
      required: ["name", "intent"],
      additionalProperties: false,
    },
    readOnly: false,

    async execute(args: Record<string, unknown>, context): Promise<ToolResult> {
      if (!context) return failure("A skill can only be changed in a chat");
      const skill = usable.find((entry) => entry.name === args.name);
      if (!skill) return failure(`No skill named "${asText(args.name)}"`);
      const description = givenText(args.description, HINTS.updateDescription);
      const instructions = givenText(args.instructions, HINTS.updateInstructions);
      const changedFiles = proposedFiles(args.files);
      if (description === undefined && instructions === undefined && changedFiles.length === 0) {
        return {
          success: true,
          data: "Nothing would change. Send the skill's new text itself, not the field hints.",
          displayText: "",
        };
      }
      if (!context.claimTurnSlot(SKILL_CARD_SLOT, MAX_SKILL_CARDS_PER_ANSWER)) {
        return failure("Only three skill cards per answer.");
      }
      const skillText = await currentText(skill, changedFiles);
      const update: SkillUpdate = {
        name: skill.name,
        ...(description !== undefined ? { description } : {}),
        ...(instructions !== undefined ? { instructions } : {}),
        files: skillText?.files ?? [],
      };
      const check = skillText
        ? await window.electronAPI
            ?.skillsCheckProposal?.({ kind: "update", update })
            .catch(() => null)
        : null;
      if (!skillText || !check || !("problems" in check)) {
        context.releaseTurnSlot(SKILL_CARD_SLOT);
        return failure(`The ${skill.name} skill couldn't be read`);
      }
      if (check.problems.length > 0) {
        context.releaseTurnSlot(SKILL_CARD_SLOT);
        const codes = check.problems.map((problem) => problem.code).join(", ");
        return { success: true, data: problemsText(codes, "update_skill"), displayText: "" };
      }
      const removals = Array.isArray(args.removals)
        ? args.removals.filter((removal): removal is string => typeof removal === "string")
        : [];
      const outcome = await requestSkillApproval(context, {
        kind: "update",
        name: skill.name,
        displayName: skill.displayName,
        draft: update,
        current: skillText.current,
        intent: asText(args.intent),
        removals: removals.slice(0, 5),
        learnedFrom: await learnedFromNote(args.learned_from_note_id),
        baseHash: check.hash,
      });
      return { success: true, data: outcomeText(outcome, "Updated"), displayText: "" };
    },
  };
}
