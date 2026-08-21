import type { SpaceItem } from "../../types/electron";
import type { ToolExecutionContext } from "./ToolRegistry";

const assertAuthorized = (context?: ToolExecutionContext): void => context?.assertAuthorized();

type ResolveFolderResult =
  | { folderId: number; created: boolean; error?: undefined }
  | { folderId?: undefined; created?: undefined; error: string };

export async function resolveFolderId(
  folderName: string,
  options: { createIfMissing?: boolean } = {},
  spaceId: number | null = null,
  context?: ToolExecutionContext
): Promise<ResolveFolderResult> {
  const normalized = typeof folderName === "string" ? folderName.trim() : "";
  if (!normalized) {
    return { error: "Folder name cannot be empty" };
  }

  assertAuthorized(context);
  const folders = await window.electronAPI.getFolders(spaceId);
  assertAuthorized(context);
  const match = folders.find((f) => f.name.toLowerCase() === normalized.toLowerCase());
  if (match) return { folderId: match.id, created: false };

  if (!options.createIfMissing) {
    const available = folders.map((f) => f.name).join(", ");
    return { error: `Folder "${normalized}" not found. Available folders: ${available}` };
  }

  assertAuthorized(context);
  const result = await window.electronAPI.createFolder(normalized, spaceId);
  assertAuthorized(context);
  if (result.success && result.folder) {
    return { folderId: result.folder.id, created: true };
  }

  assertAuthorized(context);
  const retry = await window.electronAPI.getFolders(spaceId);
  assertAuthorized(context);
  const reMatch = retry.find((f) => f.name.toLowerCase() === normalized.toLowerCase());
  if (reMatch) return { folderId: reMatch.id, created: false };

  return { error: result.error || `Failed to create folder "${normalized}"` };
}

type ResolveSpaceResult =
  { space: SpaceItem; error?: undefined } | { space?: undefined; error: string };

export function resolveSpace(spaces: SpaceItem[], spaceName: string): ResolveSpaceResult {
  const normalized = typeof spaceName === "string" ? spaceName.trim() : "";
  if (!normalized) {
    return { error: "Space name cannot be empty" };
  }

  const match = spaces.find((s) => s.name.toLowerCase() === normalized.toLowerCase());
  if (match) return { space: match };
  const available = spaces.map((s) => s.name).join(", ");
  return { error: `Space "${normalized}" not found. Available spaces: ${available}` };
}

type NoteByClientIdLookup = (
  clientNoteId: string
) => Promise<{ id: number; deleted_at?: string | null } | null>;

export async function resolveLocalNoteId(
  clientNoteId: string | null | undefined,
  lookup?: NoteByClientIdLookup,
  context?: ToolExecutionContext
): Promise<number | null> {
  const resolve =
    lookup ??
    (typeof window !== "undefined"
      ? (window.electronAPI.getNoteByClientId as NoteByClientIdLookup | undefined)
      : undefined);
  if (!clientNoteId || !resolve) return null;
  try {
    assertAuthorized(context);
    const note = await resolve(clientNoteId);
    assertAuthorized(context);
    return note && !note.deleted_at && Number.isSafeInteger(note.id) && note.id > 0
      ? note.id
      : null;
  } catch {
    assertAuthorized(context);
    // Cloud search results remain useful to the model even when their local
    // rows cannot be resolved into clickable cards.
    return null;
  }
}
