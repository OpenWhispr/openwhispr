import type { ToolDefinition, ToolResult } from "./ToolRegistry";
import { resolveFolderId } from "./utils";
import { syncNoteToCloud } from "../../stores/noteStore";

export const createNoteTool: ToolDefinition = {
  name: "create_note",
  description:
    "Create a new note with a title and content, optionally in a specific folder. If the folder does not exist, it is created automatically. Use list_folders first to avoid creating near-duplicates of existing folders.",
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
        description: "Folder name for the note. Created automatically if it does not exist.",
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

    try {
      let folderId: number | null = null;
      let folderCreated = false;

      if (folderName) {
        const resolved = await resolveFolderId(folderName, { createIfMissing: true });
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
        folderId
      );

      if (!result.success || !result.note) {
        return { success: false, data: null, displayText: "Failed to create note" };
      }

      syncNoteToCloud(result.note).catch(() => {});

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
