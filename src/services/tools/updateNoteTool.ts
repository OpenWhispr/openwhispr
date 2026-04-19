import type { ToolDefinition, ToolResult } from "./ToolRegistry";
import { resolveFolderId } from "./utils";
import { syncService } from "../SyncService.js";

export const updateNoteTool: ToolDefinition = {
  name: "update_note",
  description:
    "Before moving to a folder, always call list_folders first. Reuse an existing folder whenever one is a reasonable semantic fit for the note's topic, even if the user didn't name it. Only pass a new folder name when nothing existing fits. Updates a note's title, content, or folder (auto-created if missing). Use the note ID from context if provided; otherwise search_notes first.",
  parameters: {
    type: "object",
    properties: {
      id: {
        type: "number",
        description: "The note ID to update",
      },
      title: {
        type: "string",
        description: "New title for the note (optional)",
      },
      content: {
        type: "string",
        description: "New content for the note (optional)",
      },
      folder: {
        type: "string",
        description: "Folder name to move the note to. Created automatically if it does not exist.",
      },
    },
    required: ["id"],
    additionalProperties: false,
  },
  readOnly: false,

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const id = args.id as number;
    const title = args.title as string | undefined;
    const content = args.content as string | undefined;
    const folderName = args.folder as string | undefined;

    if (!title && !content && !folderName) {
      return {
        success: false,
        data: null,
        displayText: "At least one of title, content, or folder must be provided",
      };
    }

    try {
      const note = await window.electronAPI.getNote(id);
      if (!note) {
        return { success: false, data: null, displayText: `Note with ID ${id} not found` };
      }

      const updates: Record<string, string | number | null> = {};
      if (title) updates.title = title;
      if (content) updates.content = content;

      let folderCreated = false;
      if (folderName) {
        const resolved = await resolveFolderId(folderName, { createIfMissing: true });
        if (resolved.error) {
          return { success: false, data: null, displayText: resolved.error };
        }
        updates.folder_id = resolved.folderId;
        folderCreated = resolved.created;
      }

      const result = await window.electronAPI.updateNote(id, updates);

      if (!result.success) {
        return { success: false, data: null, displayText: "Failed to update note" };
      }

      syncService.debouncedPush("note", id);

      const suffix = folderCreated ? ` (moved to new folder "${folderName}")` : "";
      return {
        success: true,
        data: { id, title: title || note.title },
        displayText: `Updated note: "${title || note.title}"${suffix}`,
      };
    } catch (error) {
      return {
        success: false,
        data: null,
        displayText: `Failed to update note: ${(error as Error).message}`,
      };
    }
  },
};
