// Wire shapes of the /api/shared-dictionary routes. Field names stay snake_case
// as the API sends them, so a response can be stored or compared untouched.

export interface CloudSharedEntry {
  id: string;
  workspace_id: string;
  // null is the workspace-wide list; a uuid is a space's list.
  space_id: string | null;
  word: string;
  added_by_user_id: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface SharedScope {
  space_id: string | null;
  name: string;
  member_count: number;
  word_count: number;
}

export interface SharedContributor {
  user_id: string;
  name: string | null;
  is_member: boolean;
}

export interface CloudSharedHide {
  entry_id: string;
  workspace_id: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface SharedDictionaryPage {
  since?: string;
  sinceId?: string;
  cursor?: string;
  cursorId?: string;
  limit?: number;
}

export interface SharedDictionaryListResponse {
  entries: CloudSharedEntry[];
  hasMore: boolean;
  scopes: SharedScope[];
  contributors: SharedContributor[];
  paused: boolean;
  // Taken before the server's query; stored as the next `since` after a complete pass.
  server_time: string;
}

export interface SharedDictionaryHidesResponse {
  hides: CloudSharedHide[];
  hasMore: boolean;
  server_time: string;
}

export interface SharedDictionaryShareInput {
  targets: Array<string | null>;
  personal: Array<{ id: string; word: string }>;
  words: string[];
}

export interface SharedDictionaryShareResponse {
  created: CloudSharedEntry[];
  alreadyPresent: Array<{ space_id: string | null; word: string }>;
  movedPersonalIds: string[];
  // Words the shared lists refused (id is the personal row's, null for a plain word).
  rejected?: Array<{ id: string | null; word: string }>;
}

// What a pass stores alongside the entries: the lists the member can read,
// who added words, and whether the workspace has paused sharing.
export interface SharedDictionaryMeta {
  scopes: SharedScope[];
  contributors: SharedContributor[];
  paused: boolean;
}

export interface SharedDictionarySnapshotEntry {
  cloudId: string;
  spaceId: string | null;
  word: string;
  addedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

// The local mirror of one workspace, as the main process returns it.
export interface SharedDictionarySnapshot {
  entries: SharedDictionarySnapshotEntry[];
  hiddenIds: string[];
  // null until a pass has finished for this workspace.
  meta: (SharedDictionaryMeta & { syncedAt: string }) | null;
}

export interface SharedDictionaryHideRecord {
  entryId: string;
  updatedAt: string;
}
