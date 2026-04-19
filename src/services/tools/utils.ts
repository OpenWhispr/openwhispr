type ResolveFolderResult =
  | { folderId: number; created: boolean; error?: undefined }
  | { folderId?: undefined; created?: undefined; error: string };

export async function resolveFolderId(
  folderName: string,
  options: { createIfMissing?: boolean } = {}
): Promise<ResolveFolderResult> {
  const folders = await window.electronAPI.getFolders();
  const match = folders.find((f) => f.name.toLowerCase() === folderName.toLowerCase());
  if (match) return { folderId: match.id, created: false };

  if (!options.createIfMissing) {
    const available = folders.map((f) => f.name).join(", ");
    return { error: `Folder "${folderName}" not found. Available folders: ${available}` };
  }

  const result = await window.electronAPI.createFolder(folderName);
  if (result.success && result.folder) {
    return { folderId: result.folder.id, created: true };
  }

  const retry = await window.electronAPI.getFolders();
  const reMatch = retry.find((f) => f.name.toLowerCase() === folderName.toLowerCase());
  if (reMatch) return { folderId: reMatch.id, created: false };

  return { error: result.error || `Failed to create folder "${folderName}"` };
}
