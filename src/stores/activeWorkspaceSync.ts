const ACTIVE_WORKSPACE_KEY = "activeWorkspaceId";

export function installActiveWorkspaceSync(
  refreshWorkspace: (workspaceId: string | null) => void
): () => void {
  if (typeof window === "undefined") return () => {};

  const onStorage = (event: StorageEvent): void => {
    if (event.key !== ACTIVE_WORKSPACE_KEY) return;
    refreshWorkspace(event.newValue);
  };
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
}
