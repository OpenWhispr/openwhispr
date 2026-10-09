import type { ToolDefinition, ToolResult } from "./ToolRegistry";
import { withoutAttendeesFence } from "../../utils/noteAttendees";
import { transcriptPage } from "../../utils/transcriptEvidence";

export const getNoteTool: ToolDefinition = {
  name: "get_note",
  description:
    "Get a note's separate personal content, saved AI summary, and source transcript by ID. Read before editing to identify the intended field. Use search_notes first if the note ID is unknown. For more transcript evidence, supply transcript_query (literal phrase) or transcript_offset; these calls return only a 500-character passage, with speaker/time references and paging metadata.",
  parameters: {
    type: "object",
    properties: {
      id: {
        type: "number",
        description: "The note ID to retrieve",
      },
      transcript_query: {
        type: "string",
        maxLength: 120,
        description:
          "Case-insensitive literal word or phrase to find anywhere in the transcript. Omit to read sequentially. No match is not proof the topic was absent.",
      },
      transcript_offset: {
        type: "integer",
        minimum: 0,
        description:
          "Readable transcript character offset, default 0. Use transcript_next_offset for more text or the next match with the same query.",
      },
      transcript_revision: {
        type: "string",
        description:
          "Pass the revision from the previous get_note result when continuing. If the transcript changed, restart at offset 0.",
      },
    },
    required: ["id"],
    additionalProperties: false,
  },
  readOnly: true,

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const id = args.id as number;
    const query = args.transcript_query;
    const offset = args.transcript_offset ?? 0;
    const transcriptOnly = query !== undefined || args.transcript_offset !== undefined;
    if (
      !Number.isSafeInteger(id) ||
      id <= 0 ||
      !Number.isSafeInteger(offset) ||
      (offset as number) < 0 ||
      (query !== undefined && (typeof query !== "string" || !query.trim() || query.length > 120)) ||
      (args.transcript_revision !== undefined && typeof args.transcript_revision !== "string")
    ) {
      return {
        success: false,
        data: null,
        displayText: "Invalid note ID or transcript query/offset.",
      };
    }

    try {
      const note = await window.electronAPI.getNote(id);

      if (!note) {
        return {
          success: false,
          data: null,
          displayText: `Note with ID ${id} not found`,
        };
      }

      const raw = note.transcript ?? "";
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
      const revision = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0")
      ).join("");
      if (args.transcript_revision !== undefined && args.transcript_revision !== revision) {
        return {
          success: false,
          data: null,
          displayText:
            "Transcript changed. Restart get_note transcript retrieval at offset 0 without transcript_revision.",
        };
      }
      const mappings = transcriptOnly ? await window.electronAPI.getSpeakerMappings?.(id) : [];
      const speakerMappings = Object.fromEntries(
        (mappings ?? []).map((mapping) => [mapping.speaker_id, mapping.display_name])
      );
      const page = transcriptPage(
        raw,
        offset as number,
        query as string | undefined,
        speakerMappings
      );
      const evidence = { ...page, transcript_revision: revision };
      if (transcriptOnly) {
        return {
          success: true,
          data: { id: note.id, transcript_only: true, ...evidence },
          displayText: `Retrieved note: "${note.title}"`,
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
          ...evidence,
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
