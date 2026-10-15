import type { ToolDefinition, ToolResult } from "./ToolRegistry";
import { withoutAttendeesFence } from "../../utils/noteAttendees";
import {
  NOTE_TAKER_LABEL,
  isTranscriptRevision,
  isTranscriptRevisionCurrent,
  readableTranscript,
  transcriptPage,
  transcriptRevision,
} from "../../utils/transcriptEvidence";

const MAX_QUERY_LENGTH = 120;

// Models often send explicit null or a blank string for optional arguments, and
// numbers as strings.
function optionalArg(value: unknown): unknown {
  return value === null || (typeof value === "string" && !value.trim()) ? undefined : value;
}

// null marks an argument that is present but invalid.
function wholeNumberArg(value: unknown): number | null {
  const parsed = typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value) : value;
  return typeof parsed === "number" && Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function optionalStringArg(value: unknown, maxLength = Infinity): string | undefined | null {
  const present = optionalArg(value);
  if (present === undefined) return undefined;
  return typeof present === "string" && present.length <= maxLength ? present : null;
}

function failure(displayText: string): ToolResult {
  return { success: false, data: null, displayText };
}

export const getNoteTool: ToolDefinition = {
  name: "get_note",
  description: `Get a note's separate personal content, saved AI summary, and the start of its source transcript by ID. Read before editing to identify the intended field. Use search_notes first if the note ID is unknown. For more of the transcript, supply transcript_query (a literal phrase or a speaker's name) or a transcript_offset past 0; these calls return only a 500-character passage of \`Speaker: text\` lines (the person taking the notes is "${NOTE_TAKER_LABEL}"), with the times it spans and paging metadata.`,
  parameters: {
    type: "object",
    properties: {
      id: {
        type: "number",
        description: "The note ID to retrieve",
      },
      transcript_query: {
        type: "string",
        maxLength: MAX_QUERY_LENGTH,
        description:
          "Case-insensitive literal word, phrase or speaker name to find in the transcript. Omit to read sequentially. No match is not proof the topic was absent.",
      },
      transcript_offset: {
        type: "integer",
        minimum: 0,
        description:
          "Character offset in get_note's transcript text, default 0. Use transcript_next_offset for more text or the next match with the same query.",
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
    const id = wholeNumberArg(args.id);
    const rawOffset = optionalArg(args.transcript_offset);
    const offset = rawOffset === undefined ? undefined : wholeNumberArg(rawOffset);
    const query = optionalStringArg(args.transcript_query, MAX_QUERY_LENGTH);
    const revision = optionalStringArg(args.transcript_revision);
    if (!id) {
      return failure("Invalid note ID: pass the note's numeric id.");
    }
    if (offset === null) {
      return failure("Invalid transcript_offset: pass a whole number of 0 or more.");
    }
    if (query === null) {
      return failure(
        `Invalid transcript_query: pass a phrase of at most ${MAX_QUERY_LENGTH} characters.`
      );
    }
    if (revision === null || (revision !== undefined && !isTranscriptRevision(revision))) {
      return failure(
        "Invalid transcript_revision: pass the string from a previous get_note result."
      );
    }
    // Offset 0 is the default many models fill in, so it still reads the whole note.
    const transcriptOnly = query !== undefined || (offset ?? 0) > 0;

    try {
      const note = await window.electronAPI.getNote(id);

      if (!note) {
        return failure(`Note with ID ${id} not found`);
      }

      // Saved names only relabel speakers; without them the transcript still reads.
      const mappings = await window.electronAPI.getSpeakerMappings?.(id).catch(() => []);
      const transcript = readableTranscript(
        note.transcript ?? "",
        Object.fromEntries(
          (mappings ?? []).map((mapping) => [mapping.speaker_id, mapping.display_name])
        )
      );
      if (
        revision !== undefined &&
        !(await isTranscriptRevisionCurrent(transcript.text, revision))
      ) {
        return failure(
          "Transcript changed. Restart get_note transcript retrieval at offset 0 without transcript_revision."
        );
      }
      const page = transcriptPage(transcript, offset ?? 0, query);
      const evidence = {
        ...page,
        transcript_revision: await transcriptRevision(transcript.text, page.transcript_end),
      };
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
      return failure(`Failed to get note: ${(error as Error).message}`);
    }
  },
};
