const {
  headingBlock,
  markdownToBlocks,
  paragraphBlock,
  toggleBlocks,
} = require("./notionBlockConverter");

function formatDate(value) {
  const date = value
    ? new Date(String(value).replace(" ", "T") + (String(value).includes("Z") ? "" : "Z"))
    : new Date();
  if (Number.isNaN(date.getTime())) return String(value || "");
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatDuration(seconds) {
  if (!Number.isFinite(Number(seconds)) || Number(seconds) <= 0) return null;
  const totalMinutes = Math.round(Number(seconds) / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (!hours) return `${minutes} min`;
  if (!minutes) return `${hours} hr`;
  return `${hours} hr ${minutes} min`;
}

function participantNames(raw) {
  if (!raw) return [];
  try {
    const parsed = Array.isArray(raw) ? raw : JSON.parse(raw);
    return parsed
      .map((participant) => participant?.displayName || participant?.name || participant?.email)
      .filter(Boolean);
  } catch {
    return [];
  }
}

function formatTranscriptTimestamp(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  const wholeSeconds = Math.floor(seconds);
  const hours = Math.floor(wholeSeconds / 3600);
  const minutes = Math.floor((wholeSeconds % 3600) / 60);
  const remainder = wholeSeconds % 60;
  return [hours, minutes, remainder].map((part) => String(part).padStart(2, "0")).join(":");
}

function transcriptSpeaker(segment) {
  if (segment?.speakerName) return String(segment.speakerName);
  if (segment?.speaker === "you" || segment?.source === "mic") return "You";
  const speakerNumber = String(segment?.speaker || "").match(/^speaker_(\d+)$/)?.[1];
  if (speakerNumber !== undefined) return `Speaker ${Number(speakerNumber) + 1}`;
  if (segment?.source === "system") return "Others";
  return "Unknown speaker";
}

function formatTranscript(raw) {
  const fallback = String(raw || "");
  if (!fallback.trimStart().startsWith("[")) return fallback;
  try {
    const segments = JSON.parse(fallback);
    if (!Array.isArray(segments)) return fallback;
    return segments
      .filter((segment) => typeof segment?.text === "string" && segment.text.trim())
      .map((segment) => {
        const timestamp = formatTranscriptTimestamp(segment.timestamp);
        const heading = `**${transcriptSpeaker(segment)}**${timestamp ? ` \`${timestamp}\`` : ""}`;
        return `${heading}\n${segment.text.trim()}`;
      })
      .join("\n\n");
  } catch {
    return fallback;
  }
}

// Staleness of enhanced content is decided in the renderer (PersonalNotesView's
// isEnhancementStale), which sees the live editor content this process cannot.
// The publish dialog only offers contentSource "enhanced" when it is fresh.
function selectContent(note, contentSource = "enhanced") {
  if (contentSource === "enhanced" && note.enhanced_content) return note.enhanced_content;
  return note.content || "";
}

function buildMeetingBlocks(note, options) {
  const blocks = [];
  const duration = formatDuration(note.audio_duration_seconds);
  blocks.push(paragraphBlock([formatDate(note.created_at), duration].filter(Boolean).join(" · ")));

  const participants = participantNames(note.participants);
  if (participants.length) {
    blocks.push(headingBlock("Participants", 2));
    blocks.push(paragraphBlock(participants.join(", ")));
  }

  blocks.push(...markdownToBlocks(selectContent(note, options.contentSource)));

  if (options.includeTranscript && note.transcript) {
    blocks.push(...toggleBlocks("Transcript", formatTranscript(note.transcript)));
  }

  blocks.push({ object: "block", type: "divider", divider: {} });
  blocks.push(paragraphBlock("Created with OpenWhispr"));
  return blocks;
}

function buildGeneralBlocks(note, options) {
  const blocks = [
    paragraphBlock(`${formatDate(note.created_at)} · ${note.note_type || "note"}`),
    ...markdownToBlocks(selectContent(note, options.contentSource)),
  ];

  if (options.includeTranscript && note.transcript) {
    blocks.push(...toggleBlocks("Transcript", formatTranscript(note.transcript)));
  }

  blocks.push({ object: "block", type: "divider", divider: {} });
  blocks.push(paragraphBlock("Created with OpenWhispr"));
  return blocks;
}

function buildPublicationPayload(note, options = {}) {
  if (!note?.id) throw new Error("A saved note is required");
  const layoutKey = options.layoutKey || (note.note_type === "meeting" ? "meeting" : "general");
  const normalizedOptions = {
    contentSource: options.contentSource === "original" ? "original" : "enhanced",
    includeTranscript: options.includeTranscript === true,
  };
  const blocks =
    layoutKey === "meeting"
      ? buildMeetingBlocks(note, normalizedOptions)
      : buildGeneralBlocks(note, normalizedOptions);

  return {
    noteId: note.id,
    clientNoteId: note.client_note_id,
    title: (note.title || "Untitled Note").slice(0, 2000),
    layoutKey,
    contentSource: normalizedOptions.contentSource,
    includeTranscript: normalizedOptions.includeTranscript,
    blocks,
  };
}

module.exports = {
  buildPublicationPayload,
  formatDuration,
  formatTranscript,
  participantNames,
  selectContent,
};
