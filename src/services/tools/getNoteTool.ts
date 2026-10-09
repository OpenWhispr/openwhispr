import type { ToolDefinition, ToolResult } from "./ToolRegistry";
import { withoutAttendeesFence } from "../../utils/noteAttendees";

export const getNoteTool: ToolDefinition = {
  name: "get_note",
  description:
    "Get a note's separate personal content, saved AI summary, and source transcript by ID. Read before editing to identify the intended field. Use search_notes first if the note ID is unknown.",
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
          content: withoutAttendeesFence(note.content),
          summary: withoutAttendeesFence(note.enhanced_content ?? ""),
          transcript: withoutAttendeesFence(note.transcript ?? ""),
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
