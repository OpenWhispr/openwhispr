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
  | { ok: true; name: string }
  | { ok: false; problems: SkillIssue<SkillProblemCode>[] }
  | { ok: false; error: SkillWriteError }
  | SkillInvalidRequest;
