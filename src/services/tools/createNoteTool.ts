import type { ToolDefinition, ToolResult } from "./ToolRegistry";
import { resolveFolderId } from "./utils";
import { syncNoteToCloud } from "../../stores/noteStore";

export const createNoteTool: ToolDefinition = {
  name: "create_note",
  description: "Create a new note with a title and content, optionally in a specific folder.",
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
        description: "The folder name to create the note in (optional)",
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

      if (folderName) {
        const resolved = await resolveFolderId(folderName);
        if (resolved.error) {
          return { success: false, data: null, displayText: resolved.error };
        }
        folderId = resolved.folderId;
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

      return {
        success: true,
        data: { id: result.note.id, title: result.note.title },
        displayText: `Created note: "${title}"`,
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
