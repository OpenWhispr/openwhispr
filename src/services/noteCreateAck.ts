import type { NoteCreateAckResult, NoteCreateSnapshot, NoteItem } from "../types/electron";

export interface CloudNoteCreateResult {
  id: string;
  client_note_id: string | null;
  updated_at?: string | null;
  user_id?: string | null;
}

export interface NoteCreateAckDependencies {
  acknowledge: (
    id: number,
    snapshot: NoteCreateSnapshot,
    cloudId: string,
    cloudUpdatedAt: string | null,
    ownerUserId: string | null,
    settleIfUnchanged: boolean
  ) => Promise<NoteCreateAckResult | undefined>;
  deleteCloud: (cloudId: string) => Promise<void>;
  onInvalidResponse?: (expectedClientNoteId: string, receivedClientNoteId: string | null) => void;
  onCleanupError?: (cloud: CloudNoteCreateResult, error: unknown) => void;
  onUnmatchedResponse?: (cloud: CloudNoteCreateResult) => void;
}

export type NoteCreateResolution =
  | NoteCreateAckResult["outcome"]
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
  // its local note identity still exists. Such a response is an orphan of the
  // old request context and must be cleaned up without touching SQLite.
  requestStillCurrent?: () => boolean;
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
  if (!cloud.client_note_id || cloud.client_note_id !== note.client_note_id) {
    dependencies.onInvalidResponse?.(note.client_note_id, cloud.client_note_id);
    return "invalid-response";
  }
  if (options.requestStillCurrent && !options.requestStillCurrent()) {
    return cleanupOrphanedCreate(cloud, dependencies);
  }

  const result = await dependencies.acknowledge(
    note.id,
    note,
    cloud.id,
    cloud.updated_at ?? null,
    cloud.user_id ?? null,
    options.settleIfUnchanged ?? true
  );
  if (!result) return "bridge-unavailable";
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
    acknowledge: async (id, snapshot, cloudId, cloudUpdatedAt, ownerUserId, settleIfUnchanged) =>
      window.electronAPI.acknowledgeNoteCreate?.(
        id,
        snapshot,
        cloudId,
        cloudUpdatedAt,
        ownerUserId,
        settleIfUnchanged
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
  return resolveCloudNoteCreate(note, cloud, rendererDependencies(deleteCloud), options);
}

export function resolveRendererCloudNoteCreateBatch(
  notes: NoteItem[],
  created: CloudNoteCreateResult[],
  deleteCloud: (cloudId: string) => Promise<void>,
  options: NoteCreateAckOptions = {}
): Promise<NoteCreateResolution[]> {
  return resolveCloudNoteCreateBatch(notes, created, rendererDependencies(deleteCloud), options);
}
