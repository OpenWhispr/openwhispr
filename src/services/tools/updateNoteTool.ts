import type { ToolDefinition, ToolExecutionContext, ToolResult } from "./ToolRegistry";
import { resolveFolderId } from "./utils";
import { syncService } from "../SyncService.js";

export const updateNoteTool: ToolDefinition = {
  name: "update_note",
  description:
    "Updates a note's title, personal content, AI summary, or folder. Read get_note first to identify the field that contains the text being edited; content and summary are separate documents. Supply only the changed field, never the combined note context or transcript. Before moving to a folder, call list_folders and reuse an existing folder when its topic fits; only pass a new name when nothing existing fits. Use the note ID from context if provided; otherwise search_notes first.",
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
        description:
          "Complete replacement of the user's personal notes only, not the AI summary or transcript. Omit unless editing this field; an empty string clears it.",
      },
      summary: {
        type: "string",
        description:
          "Complete replacement of the saved AI Summary only. Preserve unrelated sections exactly. Omit unless editing this field; an empty string clears it.",
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

  async execute(
    args: Record<string, unknown>,
    context?: ToolExecutionContext
  ): Promise<ToolResult> {
    const id = args.id as number;
    const title = args.title as string | undefined;
    const content = args.content as string | undefined;
    const summary = args.summary as string | undefined;
    const folderName = args.folder as string | undefined;

    if (!title && typeof content !== "string" && typeof summary !== "string" && !folderName) {
      return {
        success: false,
        data: null,
        displayText: "At least one of title, content, summary, or folder must be provided",
      };
    }

    try {
      const note = await window.electronAPI.getNote(id);
      if (context?.signal.aborted) return { success: false, data: null, displayText: "" };
      if (!note) {
        return { success: false, data: null, displayText: `Note with ID ${id} not found` };
      }

      const updates: Record<string, string | number | null> = {};
      if (title) updates.title = title;
      if (typeof content === "string") updates.content = content;
      if (typeof summary === "string") updates.enhanced_content = summary;

      let folderCreated = false;
      if (folderName) {
        // Folder resolution stays within the note's space so a move by name
        // never drags the note into another space.
        const resolved = await resolveFolderId(
          folderName,
          { createIfMissing: true },
          note.space_id
        );
        if (resolved.error) {
          return { success: false, data: null, displayText: resolved.error };
        }
        updates.folder_id = resolved.folderId;
        folderCreated = resolved.created;
      }

      if (context?.signal.aborted) return { success: false, data: null, displayText: "" };
      const result = await window.electronAPI.updateNote(id, updates);

      if (!result.success) {
        return { success: false, data: null, displayText: "Failed to update note" };
      }

      syncService.debouncedPush("note", id);

      const suffix = folderCreated ? ` (moved to new folder "${folderName}")` : "";
      return {
        success: true,
        data: {
          id,
          title: title || note.title,
          updatedFields: Object.keys(updates).map((field) =>
            field === "enhanced_content" ? "summary" : field
          ),
        },
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
