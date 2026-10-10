import type {
  NoteCreateAckResult,
  NoteCreateAckWriteOptions,
  NoteCreateSnapshot,
  NoteCloudText,
  NoteItem,
} from "../types/electron";
import { NotesService } from "./NotesService";
import { hasNoteRevision } from "../helpers/noteFieldSync";
import { getValidatedAuthGeneration } from "../lib/authRequestContext";

export interface CloudNoteCreateResult extends NoteCloudText {
  id: string;
  client_note_id: string | null;
  updated_at?: string | null;
  user_id?: string | null;
  revision?: number;
  write_applied?: boolean;
  created_at?: string;
  deleted_at?: string | null;
  access_removed?: boolean;
}

export interface NoteCreateAckDependencies {
  acknowledge: (
    id: number,
    snapshot: NoteCreateSnapshot,
    cloudId: string,
    cloudUpdatedAt: string | null,
    ownerUserId: string | null,
    options: NoteCreateAckWriteOptions
  ) => Promise<NoteCreateAckResult | undefined>;
  deleteCloud: (cloudId: string) => Promise<void>;
  listCloud?: (
    limit: number,
    before?: string,
    beforeId?: string
  ) => Promise<{ notes: CloudNoteCreateResult[] }>;
  onLookupError?: (error: unknown) => void;
  onInvalidResponse?: (expectedClientNoteId: string, receivedClientNoteId: string | null) => void;
  onCleanupError?: (cloud: CloudNoteCreateResult, error: unknown) => void;
  onUnmatchedResponse?: (cloud: CloudNoteCreateResult) => void;
}

export type NoteCreateResolution =
  | NoteCreateAckResult["outcome"]
  | "write-rejected"
  | "bridge-unavailable"
  | "invalid-response"
  | "unmatched-response"
  | "orphan-cleaned"
  | "orphan-cleanup-failed";

export interface NoteCreateAckOptions {
  // Full sync creates send every mutable field and may settle an unchanged
  // row. Legacy migration creates are partial and must stay pending for the
  // subsequent full PATCH.
  settleIfUnchanged?: boolean;
  // Renderer account/reset generations can invalidate a request even when
  // its local note identity still exists.
  requestStillCurrent?: () => boolean;
}

function hasCloudText(cloud: CloudNoteCreateResult): boolean {
  return (
    typeof cloud.content === "string" &&
    (cloud.enhanced_content === null || typeof cloud.enhanced_content === "string")
  );
}

function needsLookup(cloud: CloudNoteCreateResult): boolean {
  // Revision zero cannot contain a clear: every material change advances it.
  // This keeps a normal first batch create to one network request.
  return cloud.write_applied !== false && cloud.revision !== 0 && !hasCloudText(cloud);
}

async function lookupCreatedNotes(
  created: CloudNoteCreateResult[],
  dependencies: NoteCreateAckDependencies,
  options: NoteCreateAckOptions
): Promise<Map<string, CloudNoteCreateResult>> {
  const wanted = new Map(
    created.filter(needsLookup).map((cloud) => [cloud.id, cloud.client_note_id])
  );
  const found = new Map<string, CloudNoteCreateResult>();
  if (!wanted.size || !dependencies.listCloud) return found;
  let before: string | undefined;
  let beforeId: string | undefined;
  const cursors = new Set<string>();
  try {
    while (found.size < wanted.size) {
      if (options.requestStillCurrent && !options.requestStillCurrent()) break;
      const { notes } = await dependencies.listCloud(100, before, beforeId);
      if (options.requestStillCurrent && !options.requestStillCurrent()) break;
      for (const note of notes) {
        if (
          wanted.get(note.id) === note.client_note_id &&
          hasCloudText(note) &&
          !note.deleted_at &&
          !note.access_removed
        )
          found.set(note.id, note);
      }
      const last = notes.at(-1);
      if (notes.length < 100 || !last?.created_at) break;
      const cursor = `${last.created_at}/${last.id}`;
      if (cursors.has(cursor)) break;
      cursors.add(cursor);
      before = last.created_at;
      beforeId = last.id;
    }
  } catch (error) {
    dependencies.onLookupError?.(error);
  }
  return found;
}

async function cleanupOrphanedCreate(
  cloud: CloudNoteCreateResult,
  dependencies: NoteCreateAckDependencies
): Promise<NoteCreateResolution> {
  try {
    await dependencies.deleteCloud(cloud.id);
    return "orphan-cleaned";
  } catch (error) {
    dependencies.onCleanupError?.(cloud, error);
    return "orphan-cleanup-failed";
  }
}

// Couples the atomic local acknowledgement to best-effort cleanup of a POST
// whose local identity disappeared. Keeping this small coordinator separate
// makes the destructive half of the race directly testable.
export async function resolveCloudNoteCreate(
  note: NoteItem,
  cloud: CloudNoteCreateResult,
  dependencies: NoteCreateAckDependencies,
  options: NoteCreateAckOptions = {}
): Promise<NoteCreateResolution> {
  const hydrated = await lookupCreatedNotes(
    cloud.client_note_id === note.client_note_id ? [cloud] : [],
    dependencies,
    options
  );
  return acknowledgeCloudNoteCreate(note, cloud, hydrated.get(cloud.id), dependencies, options);
}

async function acknowledgeCloudNoteCreate(
  note: NoteItem,
  cloud: CloudNoteCreateResult,
  hydrated: CloudNoteCreateResult | undefined,
  dependencies: NoteCreateAckDependencies,
  options: NoteCreateAckOptions
): Promise<NoteCreateResolution> {
  if (!cloud.client_note_id || cloud.client_note_id !== note.client_note_id) {
    dependencies.onInvalidResponse?.(note.client_note_id, cloud.client_note_id);
    return "invalid-response";
  }
  if (options.requestStillCurrent && !options.requestStillCurrent()) {
    return cloud.write_applied === false
      ? "write-rejected"
      : cloud.revision === 0
        ? cleanupOrphanedCreate(cloud, dependencies)
        : "unresolved";
  }

  if (cloud.deleted_at || cloud.access_removed) return "unresolved";
  let writeRejected = cloud.write_applied === false;
  if (needsLookup(cloud)) {
    if (!hydrated || hydrated.id !== cloud.id || hydrated.client_note_id !== cloud.client_note_id)
      return "unresolved";
    if (
      hasNoteRevision(cloud.revision) &&
      hasNoteRevision(hydrated.revision) &&
      hydrated.revision! < cloud.revision!
    )
      return "unresolved";
    // The GET may see a later edit. Link for conflict resolution, but never
    // grant that unrelated revision as the base for this request's local work.
    const sameVersion = hasNoteRevision(cloud.revision)
      ? cloud.revision === hydrated.revision
      : Boolean(
          cloud.updated_at &&
          hydrated.updated_at &&
          Date.parse(cloud.updated_at) === Date.parse(hydrated.updated_at)
        );
    writeRejected = !sameVersion;
  }
  const authoritative = hydrated ?? cloud;
  const result = await dependencies.acknowledge(
    note.id,
    note,
    cloud.id,
    writeRejected ? (note.cloud_updated_at ?? null) : (cloud.updated_at ?? null),
    authoritative.user_id ?? null,
    {
      settleIfUnchanged: (options.settleIfUnchanged ?? true) && !writeRejected,
      cloudRevision: writeRejected ? (note.cloud_revision ?? null) : (cloud.revision ?? null),
      writeRejected,
      ...(!writeRejected && hasCloudText(authoritative) && { cloudNote: authoritative }),
    }
  );
  if (!result) return "bridge-unavailable";
  // A rejected idempotent POST did not create or update this server row.
  // Link its identity for pull/conflict resolution, but grant neither a new
  // write base nor authority to delete it as an orphan of this request.
  if (writeRejected) return "write-rejected";
  if (result.outcome !== "orphaned") return result.outcome;

  // A reused create receipt may name a pre-existing row. Only an untouched
  // first-create revision can follow the orphan-cleanup path.
  return cloud.revision === 0 ? cleanupOrphanedCreate(cloud, dependencies) : "unresolved";
}

export async function resolveCloudNoteCreateBatch(
  notes: NoteItem[],
  created: CloudNoteCreateResult[],
  dependencies: NoteCreateAckDependencies,
  options: NoteCreateAckOptions = {}
): Promise<NoteCreateResolution[]> {
  const notesByClientId = new Map(notes.map((note) => [note.client_note_id, note]));
  const matched = created.filter(
    (cloud) => cloud.client_note_id && notesByClientId.has(cloud.client_note_id)
  );
  const hydrated = await lookupCreatedNotes(matched, dependencies, options);
  return Promise.all(
    created.map((cloud) => {
      const local = cloud.client_note_id ? notesByClientId.get(cloud.client_note_id) : undefined;
      if (!local) {
        dependencies.onUnmatchedResponse?.(cloud);
        return Promise.resolve<NoteCreateResolution>("unmatched-response");
      }
      return acknowledgeCloudNoteCreate(
        local,
        cloud,
        hydrated.get(cloud.id),
        dependencies,
        options
      );
    })
  );
}

function rendererDependencies(
  deleteCloud: (cloudId: string) => Promise<void>
): NoteCreateAckDependencies {
  return {
    acknowledge: async (id, snapshot, cloudId, cloudUpdatedAt, ownerUserId, options) =>
      window.electronAPI.acknowledgeNoteCreate?.(
        id,
        snapshot,
        cloudId,
        cloudUpdatedAt,
        ownerUserId,
        options
      ),
    deleteCloud,
    listCloud: (limit, before, beforeId) =>
      NotesService.list(limit, before, undefined, "all", beforeId),
    onLookupError: (error) => console.warn("Failed to fetch an authoritative created note", error),
    onInvalidResponse: (expected, received) =>
      console.error("Ignoring note create response with mismatched client identity", {
        expected,
        received,
      }),
    onCleanupError: (orphan, error) =>
      console.warn("Failed to clean up orphaned cloud note create", {
        cloudId: orphan.id,
        clientNoteId: orphan.client_note_id,
        error,
      }),
    onUnmatchedResponse: (cloud) =>
      console.error("Ignoring note create response without a matching local snapshot", {
        cloudId: cloud.id,
        clientNoteId: cloud.client_note_id,
      }),
  };
}

export function resolveRendererCloudNoteCreate(
  note: NoteItem,
  cloud: CloudNoteCreateResult,
  deleteCloud: (cloudId: string) => Promise<void>,
  options: NoteCreateAckOptions = {}
): Promise<NoteCreateResolution> {
  return resolveCloudNoteCreate(
    note,
    cloud,
    rendererDependencies(deleteCloud),
    rendererOptions(options)
  );
}

function rendererOptions(options: NoteCreateAckOptions): NoteCreateAckOptions {
  const generation = getValidatedAuthGeneration();
  return {
    ...options,
    requestStillCurrent: () =>
      getValidatedAuthGeneration() === generation && (options.requestStillCurrent?.() ?? true),
  };
}

export function resolveRendererCloudNoteCreateBatch(
  notes: NoteItem[],
  created: CloudNoteCreateResult[],
  deleteCloud: (cloudId: string) => Promise<void>,
  options: NoteCreateAckOptions = {}
): Promise<NoteCreateResolution[]> {
  return resolveCloudNoteCreateBatch(
    notes,
    created,
    rendererDependencies(deleteCloud),
    rendererOptions(options)
  );
}
