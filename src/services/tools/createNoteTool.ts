import type { ToolDefinition, ToolResult } from "./ToolRegistry";
import { resolveFolderId, resolveSpace } from "./utils";
import { syncService } from "../SyncService.js";
import { readActiveWorkspaceId } from "../../stores/workspaceStore";
import { listedDefaultWorkspaceId } from "../../lib/assistantNoteScope";
import { knownDefaultWorkspaceId } from "../../lib/workspaceSelection";
import i18n from "../../i18n";
import type { NoteScope } from "./noteScope";

// "Personal" (the name older builds gave it), "Private" or the UI language's name for it.
function namesPrivate(spaceName: string): boolean {
  const name = spaceName.trim().toLowerCase();
  return (
    name === "personal" ||
    name === "private" ||
    name === i18n.t("meetingNotification.folders.private").toLowerCase()
  );
}

/**
 * The active workspace's Private: its own row when it has one. Without one, main makes it only when
 * the workspace is known not to be the default; otherwise main's unnamed Private is used, which,
 * while main's workspace scope lags, is the bound default or the pending row. A row is never made
 * for a workspace main can't yet tell is the default (D37): the bind would later merge the
 * pending row into it.
 */
async function activePrivateSpaceId(): Promise<number | null> {
  const api = window.electronAPI;
  const activeWorkspaceId = readActiveWorkspaceId();
  if (activeWorkspaceId == null) return (await api.getPrivateSpaceId?.()) ?? null;
  const spaces = (await api.getSpaces?.()) ?? [];
  const own = spaces.find(
    (space) => space.kind === "private" && space.workspace_id === activeWorkspaceId
  );
  if (own) return own.id;
  const knownDefault = knownDefaultWorkspaceId(listedDefaultWorkspaceId(), spaces);
  const notTheDefault = knownDefault != null && knownDefault !== activeWorkspaceId;
  return (
    (await (notTheDefault
      ? api.getPrivateSpaceId?.(activeWorkspaceId)
      : api.getPrivateSpaceId?.())) ?? null
  );
}

/**
 * create_note, filing only where the turn's other note tools can read: the teamspaces in `scope`
 * (never another workspace's, where the note would sync) and the active workspace's Private.
 */
export function createCreateNoteTool(scope: NoteScope): ToolDefinition {
  const scopeSpaceIds = new Set(scope.spaceIds);
  return {
    name: "create_note",
    description:
      "Always call list_folders first. Reuse an existing folder whenever one is a reasonable semantic fit for the note's topic (e.g. a story goes into an existing 'Stories' folder), even if the user didn't name it. Only pass a new folder name when nothing existing fits. Creates a note with title, content, optional folder (auto-created if missing), and optional space. When space is omitted, the note AND its folder always stay in the user's private space — folder names never match team folders. To file a note into a team space (visible to its members), you must pass space explicitly.",
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "The title of the note",
        },
        content: {
          type: "string",
          description: "The content of the note",
        },
        folder: {
          type: "string",
          description:
            "Folder name for the note, resolved within the target space. Created automatically if it does not exist.",
        },
        space: {
          type: "string",
          description:
            "Space name to create the note in. Omit for the user's personal space — required when filing into a team space.",
        },
      },
      required: ["title", "content"],
      additionalProperties: false,
    },
    readOnly: false,

    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const title = args.title as string;
      const content = args.content as string;
      const folderName = args.folder as string | undefined;
      const spaceName = args.space as string | undefined;

      try {
        let spaceId: number | null = null;
        if (spaceName && !namesPrivate(spaceName)) {
          const spaces = (await window.electronAPI.getSpaces?.()) ?? [];
          const teamspaces = spaces.filter(
            (space) => space.kind === "team" && scopeSpaceIds.has(space.id)
          );
          const resolved = resolveSpace(teamspaces, spaceName);
          if (resolved.error) {
            return { success: false, data: null, displayText: resolved.error };
          }
          spaceId = resolved.space.id;
        } else {
          // No space argument, or Private by name, means the active workspace's
          // Private: folder resolution must never match a team folder, or the note
          // would silently inherit the team audience (D2 derives space from folder).
          spaceId = await activePrivateSpaceId();
        }

        let folderId: number | null = null;
        let folderCreated = false;

        if (folderName) {
          const resolved = await resolveFolderId(folderName, { createIfMissing: true }, spaceId);
          if (resolved.error) {
            return { success: false, data: null, displayText: resolved.error };
          }
          folderId = resolved.folderId;
          folderCreated = resolved.created;
        }

        const result = await window.electronAPI.saveNote(
          title,
          content,
          "personal",
          null,
          null,
          folderId,
          spaceId
        );

        if (!result.success || !result.note) {
          return { success: false, data: null, displayText: "Failed to create note" };
        }

        syncService.debouncedPush("note", result.note.id);

        const suffix = folderCreated ? ` in new folder "${folderName}"` : "";
        return {
          success: true,
          data: { id: result.note.id, title: result.note.title, folder_id: folderId },
          displayText: `Created note: "${title}"${suffix}`,
        };
      } catch (error) {
        return {
          success: false,
          data: null,
          displayText: `Failed to create note: ${(error as Error).message}`,
        };
      }
    },
  };
}
