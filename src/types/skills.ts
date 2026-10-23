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
  /** Over Cloud backup's caps, so it stays on this computer only. */
  tooLargeToSync?: boolean;
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

/** A skill's row in the local database, as the sync pass reads it. */
export interface SkillSyncRow {
  id: number;
  name: string;
  enabled: number;
  content_hash: string | null;
  client_skill_id: string;
  cloud_id: string | null;
  sync_status: "synced" | "pending";
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

/** A skill's files for Cloud backup, or why it stays on this computer. */
export type SkillCloudExport =
  { files: CloudSkillFile[]; contentHash: string } | { tooLargeToSync: true } | null;

export interface CloudSkillFile {
  path: string;
  encoding: "utf8" | "base64";
  content: string;
}

/** A skill as the cloud's writes return it: everything but the files. */
export interface CloudSkillMeta {
  id: string;
  client_skill_id: string | null;
  name: string;
  enabled: boolean;
  content_hash: string;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CloudSkillEntry extends CloudSkillMeta {
  files: CloudSkillFile[];
}

export type SkillWriteError = "noSpace" | "permission" | "unknown";

/** A request the main process refused before reading it. */
export type SkillInvalidRequest = { ok: false; error: "invalid" };

/** A Cloud backup lookup the main process couldn't finish; not the same as "no such skill". */
export type SkillSyncUnavailable = { ok: false; error: "unavailable" };

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
  | SkillInvalidRequest;

/** A skill a chat uses: one of the user's, or the app's built-in skill creator. */
export interface SkillRef {
  name: string;
  builtin?: boolean;
}

/** How the Skills page opens a chat: with one skill attached, or with the skill creator. */
export type SkillChatStart =
  | { kind: "try"; name: string; displayName: string }
  | { kind: "create"; draft?: { title: string; description: string } };

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
}

/** A change the assistant proposes to one of the user's skills; nothing changes until approved. */
export interface SkillUpdate {
  name: string;
  description?: string;
  instructions?: string;
  /** The full new text of each file it changes or adds. */
  files: { path: string; content: string }[];
}

export interface SkillProposalCheck {
  /** The folder saving writes. */
  name: string;
  /** A skill already has that name, so saving updates it. */
  existing: boolean;
  problems: SkillIssue<SkillProblemCode>[];
}
