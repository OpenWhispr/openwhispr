import { joinFolderPath, splitFolderPath } from "../../components/notes/shared";
import type { FolderItem, SpaceItem } from "../../types/electron";

type ResolveFolderResult =
  | { folderId: number; created: boolean; error?: undefined }
  | { folderId?: undefined; created?: undefined; error: string };

const sameFolderName = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

// The label list_folders shows, so a model can pass back what it was given.
function folderLabels(folders: FolderItem[]): Array<{ folder: FolderItem; label: string }> {
  const nameById = new Map(folders.map((f) => [f.id, f.name]));
  return folders.map((folder) => {
    const parentName =
      folder.parent_folder_id == null ? null : nameById.get(folder.parent_folder_id);
    return { folder, label: parentName ? joinFolderPath(parentName, folder.name) : folder.name };
  });
}

// A folder may literally be named "A / B", so its name wins over a label.
function findFolder(folders: FolderItem[], name: string): FolderItem | undefined {
  return (
    folders.find((f) => sameFolderName(f.name, name)) ??
    folderLabels(folders).find(({ label }) => sameFolderName(label, name))?.folder
  );
}

const availableFolders = (folders: FolderItem[]): string =>
  `Available folders: ${folderLabels(folders)
    .map(({ label }) => label)
    .join(", ")}`;

export async function resolveFolderId(
  folderName: string,
  options: { createIfMissing?: boolean } = {},
  spaceId: number | null = null
): Promise<ResolveFolderResult> {
  const normalized = typeof folderName === "string" ? folderName.trim() : "";
  if (!normalized) {
    return { error: "Folder name cannot be empty" };
  }

  const folders = await window.electronAPI.getFolders(spaceId);
  const match = findFolder(folders, normalized);
  if (match) return { folderId: match.id, created: false };

  const notFound = `Folder "${normalized}" not found. ${availableFolders(folders)}`;
  if (!options.createIfMissing) return { error: notFound };

  // A label names a subfolder, so it never becomes a top-level folder with a
  // slash in its name. Only a top-level folder can hold subfolders.
  const path = splitFolderPath(normalized);
  const parent =
    path &&
    folders.find((f) => f.parent_folder_id == null && sameFolderName(f.name, path.parentName));
  if (path && !parent) return { error: notFound };

  const result =
    path && parent
      ? await window.electronAPI.createFolder(path.name, parent.space_id, parent.id)
      : await window.electronAPI.createFolder(normalized, spaceId);
  if (result.success && result.folder) {
    return { folderId: result.folder.id, created: true };
  }

  const retry = await window.electronAPI.getFolders(spaceId);
  const reMatch = findFolder(retry, normalized);
  if (reMatch) return { folderId: reMatch.id, created: false };

  const reason = result.error || `Failed to create folder "${normalized}"`;
  return { error: `${reason}. ${availableFolders(retry)}` };
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
