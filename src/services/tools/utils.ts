export async function resolveFolderId(
  folderName: string
): Promise<{ folderId: number; error?: undefined } | { folderId?: undefined; error: string }> {
  const folders = await window.electronAPI.getFolders();

  const match = folders.find((f) => f.name.toLowerCase() === folderName.toLowerCase());
  if (match) return { folderId: match.id };

  const available = folders.map((f) => f.name).join(", ");
  return { error: `Folder "${folderName}" not found. Available folders: ${available}` };
}
