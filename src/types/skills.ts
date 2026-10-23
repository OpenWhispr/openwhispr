// The skills library's shapes, as the main process returns them (src/helpers/skills).

export type SkillProblemCode =
  | "missingName"
  | "missingDescription"
  | "frontmatterMissing"
  | "frontmatterInvalid"
  | "frontmatterNotMapping"
  | "nameFormat"
  | "nameTooLong"
  | "descriptionTooLong"
  | "descriptionAngleBrackets"
  | "noSkillFile"
  | "multipleSkillFiles"
  | "skillFileTooDeep"
  | "unsafePath"
  | "symlink"
  | "tooLarge"
  | "tooManyFiles"
  | "unsupportedFile"
  | "unreadableArchive"
  | "nameMismatch"
  | "unreadable"
  | "skillFileNotUtf8"
  | "placeholder"
  | "nameTaken";

export type SkillWarningCode =
  "folderRenamed" | "reservedWord" | "longBody" | "longDescription" | "unknownKeys";

export interface SkillIssue<C extends string> {
  code: C;
  values?: Record<string, string | number>;
}

export interface SkillSummary {
  /** The folder name, which a valid skill's header name matches. */
  name: string;
  /** metadata.display_name, else the name prettified. */
  displayName: string;
  description: string;
  /** The stored switch. */
  enabled: boolean;
  /** False for a skill that needs fixing; it can't be switched on. */
  valid: boolean;
  problem?: SkillIssue<SkillProblemCode>;
  addedAt: string | null;
  updatedAt: string | null;
  lastUsedAt: string | null;
}

export interface SkillFileInfo {
  path: string;
  size: number;
  text: boolean;
  script: boolean;
}

export interface SkillDetail extends SkillSummary {
  /** SKILL.md exactly as stored. */
  markdown: string;
  /** Every file except SKILL.md, sorted by path. */
  files: SkillFileInfo[];
}

export interface SkillUploadItem {
  fileName: string;
  data: Uint8Array;
}

export interface SkillUploadPreview {
  fileName: string;
  status: "ready" | "duplicate" | "invalid";
  /** What installs this file; ready and duplicate only. */
  token?: string;
  name?: string;
  displayName?: string;
  problems: SkillIssue<SkillProblemCode>[];
  warnings: SkillIssue<SkillWarningCode>[];
}

export type SkillWriteError = "noSpace" | "permission" | "unknown";

/** A request the main process refused before reading it. */
export type SkillInvalidRequest = { ok: false; error: "invalid" };

export interface SkillCommitResult {
  installed: string[];
  /** "exists" when a skill by that name is there and wasn't named to be replaced. */
  failed: { fileName: string; error: SkillWriteError | "exists" }[];
}

export interface SkillCreateInput {
  title: string;
  description: string;
  instructions: string;
  files: SkillUploadItem[];
}

export type SkillSaveResult =
  | {
      ok: true;
      name: string;
      /** The copy Undo restores, when the save replaced a skill. */
      versionId?: string;
    }
  | { ok: false; problems: SkillIssue<SkillProblemCode>[] }
  | { ok: false; error: SkillWriteError }
  /** A save from a card made before the skill last changed; nothing was written. */
  | { ok: false; error: "changed" }
  | SkillInvalidRequest;

/** A skill a chat uses: one of the user's, or the app's built-in skill creator. */
export interface SkillRef {
  name: string;
  builtin?: boolean;
}

/** How the Skills page opens a chat: with one skill attached, or with the skill creator. */
export type SkillChatStart =
  { kind: "try"; name: string; displayName: string } | { kind: "create"; draft?: SkillChatDraft };

/** What Draft with assistant hands the skill creator from the Create skill form. */
export interface SkillChatDraft {
  title: string;
  description: string;
  instructions: string;
  /** The names of the files the form holds; their content stays in the form. */
  fileNames: string[];
}

/** A chat start on its way to the chat view; a new id is a new request. */
export type SkillChatRequest = SkillChatStart & { id: number };

/** Open skill, from a chat: the Skills page opens that skill. A new id is a new request. */
export interface SkillOpenRequest {
  id: number;
  name: string;
}

/** A skill as the assistant reads it. */
export interface SkillForModel {
  name: string;
  displayName: string;
  /** SKILL.md without its header block. */
  body: string;
  /** Every file but SKILL.md; content only on the text files that were asked for. */
  files: Array<SkillFileInfo & { content?: string }>;
}

/** A new skill the assistant proposes; nothing is written until the user approves it. */
export interface SkillProposal {
  title: string;
  description: string;
  instructions: string;
  files: { path: string; content: string }[];
  /** For a proposal that updates a skill: the skill's hash when its card was made. */
  baseHash?: string;
}

/** A change the assistant proposes to one of the user's skills; nothing changes until approved. */
export interface SkillUpdate {
  name: string;
  description?: string;
  instructions?: string;
  /** The full new text of each file it changes or adds. */
  files: { path: string; content: string }[];
  /** The skill's hash when its card was made; a save after the skill changed is refused. */
  baseHash?: string;
}

export interface SkillProposalCheck {
  /** The folder saving writes. */
  name: string;
  /** A skill already has that name, so saving updates it. */
  existing: boolean;
  problems: SkillIssue<SkillProblemCode>[];
  /** The hash of the skill saving would change, for its save to compare. */
  hash?: string;
}
