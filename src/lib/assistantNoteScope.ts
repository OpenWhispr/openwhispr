import {
  readActiveWorkspaceId,
  readCachedDefaultWorkspaceId,
  useWorkspaceStore,
} from "../stores/workspaceStore";
import logger from "../utils/logger";
import { assistantScopeSpaceIds } from "./workspaceSelection";

/**
 * The default workspace a workspace list names: this window's, else (the dictation window loads
 * none) the last list the account saw. knownDefaultWorkspaceId adds the one main last bound.
 */
export function listedDefaultWorkspaceId(): string | null {
  return useWorkspaceStore.getState().defaultWorkspaceId ?? readCachedDefaultWorkspaceId();
}

/**
 * The spaces whose notes one assistant turn may read: search, its context and every note tool. The
 * same rule in every chat surface and window (see assistantScopeSpaceIds): the control panel's
 * store holds the workspace list, while the dictation window's never loads one and works from the
 * rows main already has. Main is never asked for a named workspace's Private here: while its own
 * workspace scope lags, that would make a row for a workspace it can't yet tell is the default
 * (D37). Anything that fails reads nothing while a workspace is active, and main's Private alone
 * otherwise: never every space.
 */
export async function resolveAssistantScopeSpaceIds(): Promise<number[]> {
  const api = typeof window !== "undefined" ? window.electronAPI : undefined;
  // The saved choice every window shares, as the tools that write notes use.
  const activeWorkspaceId = readActiveWorkspaceId();
  let privateSpaceId: number | null = null;
  try {
    const [privateRead, spacesRead] = await Promise.allSettled([
      api?.getPrivateSpaceId?.(),
      api?.getSpaces?.(),
    ]);
    if (privateRead.status === "rejected") throw privateRead.reason;
    privateSpaceId = privateRead.value ?? null;
    if (spacesRead.status === "rejected") throw spacesRead.reason;
    const { workspaces, defaultWorkspaceId } = useWorkspaceStore.getState();
    const listed = workspaces.some((workspace) => workspace.id === activeWorkspaceId);
    return assistantScopeSpaceIds({
      spaces: spacesRead.value ?? [],
      activeWorkspaceId,
      workspaces,
      // A loaded list scopes as the tree does, by its own default.
      defaultWorkspaceId: listed ? defaultWorkspaceId : listedDefaultWorkspaceId(),
      privateSpaceId,
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

/**
 * Whether a chat list shows this chat while the assistant's scope is `scopeSpaceIds` (from
 * resolveAssistantScopeSpaceIds). A chat about a note outside the active workspace stays out, as
 * that note stays out of the chat's grounding: opened, its earlier replies would reach the model as
 * history. Root chats, and chats whose note is gone (`note_space_id` null), always show. Every
 * chat list goes through this: the Chat list, command search's conversations and the agent
 * window's chat switcher.
 */
export function isConversationInScope(
  conversation: { note_space_id?: number | null },
  scopeSpaceIds: readonly number[]
): boolean {
  return conversation.note_space_id == null || scopeSpaceIds.includes(conversation.note_space_id);
}
