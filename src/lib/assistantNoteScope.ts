import { readActiveWorkspaceId, useWorkspaceStore } from "../stores/workspaceStore";
import logger from "../utils/logger";
import { assistantScopeSpaceIds } from "./workspaceSelection";

/**
 * The spaces whose notes one assistant turn may read: search, its context and every note tool. The
 * same rule in every chat surface and window (see assistantScopeSpaceIds): the control panel's
 * store holds the workspace list, while the dictation window's never loads one and falls back to
 * main. Anything that fails reads nothing while a workspace is active (which workspace main's
 * Private belongs to can't be checked then), and main's Private alone otherwise: never every space.
 */
export async function resolveAssistantScopeSpaceIds(): Promise<number[]> {
  const api = typeof window !== "undefined" ? window.electronAPI : undefined;
  // The saved choice every window shares, as the tools that write notes use.
  const activeWorkspaceId = readActiveWorkspaceId();
  let privateSpaceId: number | null = null;
  try {
    // Named, since main's own workspace scope lags at startup and after an account change. Asked
    // first: main answers in order, so the spaces include a Private this call just made.
    const [privateRead, spacesRead] = await Promise.allSettled([
      api?.getPrivateSpaceId?.(activeWorkspaceId),
      api?.getSpaces?.(),
    ]);
    if (privateRead.status === "rejected") throw privateRead.reason;
    privateSpaceId = privateRead.value ?? null;
    if (spacesRead.status === "rejected") throw spacesRead.reason;
    const { workspaces, defaultWorkspaceId } = useWorkspaceStore.getState();
    const listed = workspaces.some((workspace) => workspace.id === activeWorkspaceId);
    const defaultPrivateSpaceId = listed
      ? null
      : ((await api?.getDefaultPrivateSpaceId?.()) ?? null);
    return assistantScopeSpaceIds({
      spaces: spacesRead.value ?? [],
      activeWorkspaceId,
      workspaces,
      defaultWorkspaceId,
      privateSpaceId,
      defaultPrivateSpaceId,
    });
  } catch (error) {
    logger.warn(
      "Failed to resolve the assistant's workspace scope",
      { error: (error as Error).message },
      "workspaces"
    );
    return activeWorkspaceId == null && privateSpaceId != null ? [privateSpaceId] : [];
  }
}
