import type {
  NoteCreateAckResult,
  NoteCreateAckWriteOptions,
  NoteCreateSnapshot,
  NoteCloudText,
  NoteItem,
} from "../types/electron";
import { getValidatedAuthGeneration } from "../lib/authRequestContext";

export interface CloudNoteCreateResult extends NoteCloudText {
  id: string;
  client_note_id: string | null;
  updated_at?: string | null;
  user_id?: string | null;
  revision?: number;
  write_applied?: boolean;
  row_created?: boolean;
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
  | "orphan-unproven"
  | "orphan-cleanup-failed";

export interface NoteCreateAckOptions {
  // Full sync creates send every mutable field and may settle an unchanged
  // row. Legacy migration creates are partial and must stay pending for the
  // subsequent full PATCH.
  settleIfUnchanged?: boolean;
  // Renderer account/reset generations can invalidate a request even when
  // its local note identity still exists. Such a response is an orphan of the
  // old request context and must be cleaned up without touching SQLite.
  requestStillCurrent?: () => boolean;
}

async function cleanupOrphanedCreate(
  cloud: CloudNoteCreateResult,
  dependencies: NoteCreateAckDependencies
): Promise<NoteCreateResolution> {
  // Applied upserts can target an existing row. Only an atomic insertion
  // receipt gives this request authority to clean up its cloud orphan.
  if (cloud.row_created !== true) return "orphan-unproven";
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
  if (!cloud.client_note_id || cloud.client_note_id !== note.client_note_id) {
    dependencies.onInvalidResponse?.(note.client_note_id, cloud.client_note_id);
    return "invalid-response";
  }
  if (options.requestStillCurrent && !options.requestStillCurrent()) {
    return cloud.write_applied === false
      ? "write-rejected"
      : cleanupOrphanedCreate(cloud, dependencies);
  }

  if (cloud.deleted_at || cloud.access_removed) return "unresolved";
  const writeRejected = cloud.write_applied === false;
  const hasCloudText =
    typeof cloud.content === "string" &&
    (typeof cloud.enhanced_content === "string" || cloud.enhanced_content === null);
  const result = await dependencies.acknowledge(
    note.id,
    note,
    cloud.id,
    writeRejected ? (note.cloud_updated_at ?? null) : (cloud.updated_at ?? null),
    cloud.user_id ?? null,
    {
      settleIfUnchanged: (options.settleIfUnchanged ?? true) && !writeRejected,
      cloudRevision: writeRejected ? (note.cloud_revision ?? null) : (cloud.revision ?? null),
      writeRejected,
      ...(!writeRejected && {
        cloudNote: hasCloudText ? cloud : undefined,
        requiresReconciliation: !hasCloudText,
      }),
    }
  );
  if (!result) return "bridge-unavailable";
  // A rejected idempotent POST did not create or update this server row.
  // Link its identity for pull/conflict resolution, but grant neither a new
  // write base nor authority to delete it as an orphan of this request.
  if (writeRejected) return "write-rejected";
  if (result.outcome !== "orphaned") return result.outcome;

  return cleanupOrphanedCreate(cloud, dependencies);
}

export async function resolveCloudNoteCreateBatch(
  notes: NoteItem[],
  created: CloudNoteCreateResult[],
  dependencies: NoteCreateAckDependencies,
  options: NoteCreateAckOptions = {}
): Promise<NoteCreateResolution[]> {
  const notesByClientId = new Map(notes.map((note) => [note.client_note_id, note]));
  return Promise.all(
    created.map((cloud) => {
      const local = cloud.client_note_id ? notesByClientId.get(cloud.client_note_id) : undefined;
      if (!local) {
        dependencies.onUnmatchedResponse?.(cloud);
        return Promise.resolve<NoteCreateResolution>("unmatched-response");
      }
      return resolveCloudNoteCreate(local, cloud, dependencies, options);
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
