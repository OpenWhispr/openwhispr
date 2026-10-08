import type { ToolDefinition, ToolResult } from "./ToolRegistry";
import { withoutAttendeesFence } from "../../utils/noteAttendees";

export const getNoteTool: ToolDefinition = {
  name: "get_note",
  description:
    "Get the full content of a specific note by ID. Use search_notes first to find the note ID.",
  parameters: {
    type: "object",
    properties: {
      id: {
        type: "number",
        description: "The note ID to retrieve",
      },
    },
    required: ["id"],
    additionalProperties: false,
  },
  readOnly: true,

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const id = args.id as number;

    try {
      const note = await window.electronAPI.getNote(id);

      if (!note) {
        return {
          success: false,
          data: null,
          displayText: `Note with ID ${id} not found`,
        };
      }

      // Only the note chat's own attendee block may carry its fence.
      return {
        success: true,
        data: {
          id: note.id,
          title: withoutAttendeesFence(note.title),
          content: withoutAttendeesFence(note.enhanced_content || note.content),
          type: note.note_type,
          folder_id: note.folder_id,
          created_at: note.created_at,
          updated_at: note.updated_at,
        },
        displayText: `Retrieved note: "${note.title}"`,
      };
    } catch (error) {
      return {
        success: false,
        data: null,
        displayText: `Failed to get note: ${(error as Error).message}`,
      };
    }
  },
};
