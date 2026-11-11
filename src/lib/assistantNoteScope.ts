import { readActiveWorkspaceId, useWorkspaceStore } from "../stores/workspaceStore";
import logger from "../utils/logger";
import { assistantScopeSpaceIds } from "./workspaceSelection";

/**
 * The spaces whose notes one assistant turn may read: search, its context and every note tool. The
 * same rule in every chat surface and window (see assistantScopeSpaceIds): the control panel's
 * store holds the workspace list, while the dictation window's never loads one and falls back to
 * main. Anything that fails leaves main's Private alone, or nothing at all, never every space.
 */
export async function resolveAssistantScopeSpaceIds(): Promise<number[]> {
  const api = typeof window !== "undefined" ? window.electronAPI : undefined;
  let privateSpaceId: number | null = null;
  try {
    privateSpaceId = (await api?.getPrivateSpaceId?.()) ?? null;
    const spaces = (await api?.getSpaces?.()) ?? [];
    // The saved choice every window shares, as the tools that write notes use.
    const activeWorkspaceId = readActiveWorkspaceId();
    const { workspaces, defaultWorkspaceId } = useWorkspaceStore.getState();
    const listed = workspaces.some((workspace) => workspace.id === activeWorkspaceId);
    const defaultPrivateSpaceId = listed
      ? null
      : ((await api?.getDefaultPrivateSpaceId?.()) ?? null);
    return assistantScopeSpaceIds({
      spaces,
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
    return privateSpaceId == null ? [] : [privateSpaceId];
  }
}
