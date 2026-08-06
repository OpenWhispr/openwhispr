import type { SpaceItem } from "../../types/electron";

type ResolveFolderResult =
  | { folderId: number; created: boolean; error?: undefined }
  | { folderId?: undefined; created?: undefined; error: string };

export async function resolveFolderId(
  folderName: string,
  options: { createIfMissing?: boolean } = {},
  spaceId: number | null = null
): Promise<ResolveFolderResult> {
  const folders = await window.electronAPI.getFolders(spaceId);
  const match = folders.find((f) => f.name.toLowerCase() === folderName.toLowerCase());
  if (match) return { folderId: match.id, created: false };

  if (!options.createIfMissing) {
    const available = folders.map((f) => f.name).join(", ");
    return { error: `Folder "${folderName}" not found. Available folders: ${available}` };
  }

  const result = await window.electronAPI.createFolder(folderName, spaceId);
  if (result.success && result.folder) {
    return { folderId: result.folder.id, created: true };
  }

  const retry = await window.electronAPI.getFolders(spaceId);
  const reMatch = retry.find((f) => f.name.toLowerCase() === folderName.toLowerCase());
  if (reMatch) return { folderId: reMatch.id, created: false };

  return { error: result.error || `Failed to create folder "${folderName}"` };
}

type ResolveSpaceResult =
  { space: SpaceItem; error?: undefined } | { space?: undefined; error: string };

export function resolveSpace(spaces: SpaceItem[], spaceName: string): ResolveSpaceResult {
  const match = spaces.find((s) => s.name.toLowerCase() === spaceName.trim().toLowerCase());
  if (match) return { space: match };
  const available = spaces.map((s) => s.name).join(", ");
  return { error: `Space "${spaceName}" not found. Available spaces: ${available}` };
}

type NoteByClientIdLookup = (
  clientNoteId: string
) => Promise<{ id: number; deleted_at?: string | null } | null>;

export async function resolveLocalNoteId(
  clientNoteId: string | null | undefined,
  lookup?: NoteByClientIdLookup
): Promise<number | null> {
  const resolve =
    lookup ??
    (typeof window !== "undefined"
      ? (window.electronAPI.getNoteByClientId as NoteByClientIdLookup | undefined)
      : undefined);
  if (!clientNoteId || !resolve) return null;
  try {
    const note = await resolve(clientNoteId);
    return note && !note.deleted_at && Number.isSafeInteger(note.id) && note.id > 0
      ? note.id
      : null;
  } catch {
    // Cloud search results remain useful to the model even when their local
    // rows cannot be resolved into clickable cards.
    return null;
  }
}
