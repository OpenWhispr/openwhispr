export const ACTIVE_WORKSPACE_KEY = "activeWorkspaceId";

interface StorageChangeEvent {
  key: string | null;
  newValue: string | null;
  storageArea: Storage | null;
}

interface StorageEventTarget {
  addEventListener(type: "storage", listener: (event: StorageChangeEvent) => void): void;
  removeEventListener(type: "storage", listener: (event: StorageChangeEvent) => void): void;
}

export function subscribeToActiveWorkspaceStorageChanges(
  eventTarget: StorageEventTarget,
  storage: Storage,
  getCurrentWorkspaceId: () => string | null,
  applyWorkspaceId: (workspaceId: string | null) => void
): () => void {
  const handleStorage = (event: StorageChangeEvent): void => {
    if (
      event.key !== ACTIVE_WORKSPACE_KEY ||
      (event.storageArea && event.storageArea !== storage) ||
      event.newValue === getCurrentWorkspaceId()
    ) {
      return;
    }
    applyWorkspaceId(event.newValue);
  };
  eventTarget.addEventListener("storage", handleStorage);
  return () => eventTarget.removeEventListener("storage", handleStorage);
}
