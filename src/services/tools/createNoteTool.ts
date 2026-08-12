import type { ToolDefinition, ToolResult } from "./ToolRegistry";
import { resolveFolderId, resolveSpace } from "./utils";
import { syncService } from "../SyncService.js";

export const createNoteTool: ToolDefinition = {
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
      const spaces = (await window.electronAPI.getSpaces?.()) ?? [];
      if (spaceName) {
        const resolved = resolveSpace(spaces, spaceName);
        if (resolved.error) {
          return { success: false, data: null, displayText: resolved.error };
        }
        spaceId = resolved.space.id;
      } else {
        // No space argument means the user's private space: folder resolution
        // must never match a team folder, or the note would silently inherit
        // the team audience (D2 derives space from folder).
        spaceId = spaces.find((s) => s.kind === "private")?.id ?? null;
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
