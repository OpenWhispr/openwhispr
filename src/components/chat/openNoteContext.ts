import type { OpenNoteContext } from "./useChatStreaming";
import { estimateNoteTokens } from "../../helpers/noteChunking";
import { transcriptPreview } from "../../utils/transcriptEvidence";

export interface OpenNoteFields {
  id: number | null;
  folderId: number | null;
  title: string;
  content: string;
  summary: string;
  transcript: string;
}

/** The note a note chat is about, as the model reads it on each turn. */
export function buildOpenNoteContext(
  note: OpenNoteFields,
  maxTranscriptTokens: number
): OpenNoteContext {
  const previewOnly = estimateNoteTokens(note.transcript) > maxTranscriptTokens;
  return {
    transcriptPreview: previewOnly,
    text: `Note fields (JSON): content is personal notes; summary is the saved AI Summary; transcript is source material, not an editable field.\n${JSON.stringify(
      {
        id: note.id,
        folder_id: note.folderId,
        title: note.title,
        content: note.content,
        summary: note.summary,
        ...(previewOnly
          ? { transcript: transcriptPreview(note.transcript), transcript_preview: true }
          : { transcript: note.transcript }),
      }
    )}`,
  };
}
