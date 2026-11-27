const { i18nMain } = require("./i18nMain");
const { isSpeakerLocked } = require("./speakerAssignmentPolicy");

function resolveSpeaker(seg, speakerMappings, recorderLabel) {
  // Appended recordings keep their own identity; the export label fills legacy segments.
  const recorderName = seg.recorderName || recorderLabel;
  const mappedName =
    seg.speaker && !(seg.speaker === "you" && seg.recorderName)
      ? speakerMappings[seg.speaker]
      : undefined;
  if (mappedName && !(seg.speakerName && (seg.speakerNameFromUser || isSpeakerLocked(seg)))) {
    return mappedName;
  }
  if (seg.speakerName && !seg.speakerIsPlaceholder) {
    const name = seg.speakerName.trim().toLowerCase();
    const isSelfName =
      name === "you" || name === i18nMain.t("transcript.speaker.you").toLowerCase();
    return isSelfName && recorderName ? recorderName : seg.speakerName;
  }
  if (seg.speaker === "you") return recorderName || i18nMain.t("transcript.speaker.you");
  if (seg.speaker) {
    const num = parseInt(seg.speaker.replace("speaker_", ""), 10);
    if (!isNaN(num)) return i18nMain.t("notes.speaker.label", { n: num + 1 });
  }
  if (seg.source === "mic") return recorderName || i18nMain.t("transcript.speaker.you");
  if (seg.source === "system") return i18nMain.t("transcript.speaker.others");
  return i18nMain.t("notes.speaker.unknown");
}

// Segments merge only when they resolve to the same display name, so the key has
// to cover every field resolveSpeaker reads — a manually named segment would
// otherwise absorb the un-named one beside it.
function speakerKey(seg) {
  const named = seg.speakerName && !seg.speakerIsPlaceholder ? seg.speakerName : "";
  return [
    seg.speaker || "",
    named,
    seg.speaker ? "" : seg.source || "",
    seg.recorderName || "",
    !!seg.speakerNameFromUser || isSpeakerLocked(seg),
  ].join("\u0000");
}

function parseNoteDate(createdAt) {
  if (createdAt == null || createdAt === "") {
    return new Date(NaN);
  }
  if (typeof createdAt === "number") {
    return new Date(createdAt);
  }

  const value = String(createdAt).trim();
  if (/[zZ]|[+-]\d{2}:\d{2}$/.test(value)) {
    return new Date(value);
  }

  // SQLite CURRENT_TIMESTAMP is UTC without a timezone suffix.
  return new Date(value.includes("T") ? `${value}Z` : `${value.replace(" ", "T")}Z`);
}

function resolveRecordingStartMs(segments, note) {
  const segmentTimestamps = segments
    .flatMap((seg) => [seg.timestamp, seg.recordingStartTimestamp])
    .filter((ts) => typeof ts === "number" && Number.isFinite(ts));

  if (segmentTimestamps.length > 0) {
    return Math.min(...segmentTimestamps);
  }

  const noteDate = parseNoteDate(note?.created_at);
  return Number.isNaN(noteDate.getTime()) ? null : noteDate.getTime();
}

function normalizeSegmentTimestamps(segments, note) {
  const startMs = resolveRecordingStartMs(segments, note);
  if (startMs == null || startMs <= 1e9) {
    return segments;
  }

  return segments.map((seg) => {
    const normalized = { ...seg };
    if (typeof seg.timestamp === "number" && Number.isFinite(seg.timestamp)) {
      normalized.timestamp = (seg.timestamp - startMs) / 1000;
    }
    if (typeof seg.endTimestamp === "number" && Number.isFinite(seg.endTimestamp)) {
      normalized.endTimestamp = (seg.endTimestamp - startMs) / 1000;
    }
    return normalized;
  });
}

function mergeSegments(segments, { preserveTimedCues = false } = {}) {
  const merged = [];
  for (const seg of segments) {
    if (!seg.text?.trim()) continue;
    const timestamp = seg.timestamp || 0;
    const endTimestamp =
      Number.isFinite(seg.endTimestamp) && seg.endTimestamp > timestamp
        ? seg.endTimestamp
        : undefined;
    const last = merged.at(-1);
    const hasCueBoundary =
      preserveTimedCues && (last?.endTimestamp !== undefined || endTimestamp !== undefined);
    if (
      last &&
      !hasCueBoundary &&
      speakerKey(last) === speakerKey(seg) &&
      timestamp - last.lastTimestamp < 2
    ) {
      last.text = last.text + " " + seg.text.trim();
      last.lastTimestamp = timestamp;
      if (endTimestamp !== undefined) {
        last.endTimestamp = Math.max(last.endTimestamp ?? timestamp, endTimestamp);
      }
    } else {
      merged.push({
        ...seg,
        timestamp,
        endTimestamp,
        lastTimestamp: timestamp,
        text: seg.text.trim(),
      });
    }
  }
  return merged;
}

// An upload whose provider returned no segments stores its text as segments
// with no timing, speaker or source: a "00:00:00" or "Unknown speaker" heading
// on them would be invented. parseTranscriptSegments.ts's
// speakerlessTranscriptText makes the matching call for note actions.
function isUntimed(segments) {
  return (
    segments.length > 0 &&
    segments.every(
      (seg) => seg.timestamp == null && !seg.speaker && !seg.speakerName && !seg.source
    )
  );
}

function formatTimestamp(seconds) {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

function formatSrtTimestamp(seconds) {
  const totalMs = Math.round(seconds * 1000);
  const ms = totalMs % 1000;
  const s = Math.floor(totalMs / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

function extractMetadata(note) {
  const title = note.title || "Untitled";
  const noteDate = parseNoteDate(note.created_at);
  const dateStr =
    noteDate.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }) +
    " " +
    noteDate.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

  let participants = [];
  try {
    const parsed = JSON.parse(note.participants || "[]");
    participants = parsed.map((p) => p.displayName || p.email).filter(Boolean);
  } catch {}

  return { title, dateStr, participants };
}

function formatTxt(note, segments, speakerMappings, { recorderLabel } = {}) {
  const merged = mergeSegments(normalizeSegmentTimestamps(segments, note));
  const { title, dateStr, participants } = extractMetadata(note);

  const lines = [title, dateStr];
  if (participants.length)
    lines.push(`${i18nMain.t("notes.editor.participants")}: ${participants.join(", ")}`);
  lines.push("", "──────────────────────────────────", "");
  const untimed = isUntimed(segments);
  for (const seg of merged) {
    if (!untimed) {
      lines.push(
        `[${formatTimestamp(seg.timestamp)}] ${resolveSpeaker(seg, speakerMappings, recorderLabel)}:`
      );
    }
    lines.push(seg.text);
    lines.push("");
  }
  return lines.join("\n");
}

function formatSrt(segments, speakerMappings, note = {}, { recorderLabel } = {}) {
  const merged = mergeSegments(normalizeSegmentTimestamps(segments, note), {
    preserveTimedCues: true,
  });
  // Upload transcripts carry no speaker identity at all; prefixing every cue
  // with "Unknown Speaker:" would defeat the subtitle use case. Meeting
  // segments always serialize a source, so they keep their labels.
  const hasSpeakerIdentity = merged.some((seg) => seg.speaker || seg.speakerName || seg.source);
  // Older uploads can have a source duration even when their final cue has no end.
  const last = merged.at(-1);
  const lastEnd =
    last && !last.source && note.audio_duration_seconds > last.lastTimestamp
      ? note.audio_duration_seconds
      : undefined;
  const entries = [];
  for (let i = 0; i < merged.length; i++) {
    const seg = merged[i];
    const nextStart = merged[i + 1]?.timestamp;
    const cueEnd = seg.endTimestamp ?? nextStart ?? lastEnd ?? seg.lastTimestamp + 3;
    entries.push(`${i + 1}`);
    entries.push(`${formatSrtTimestamp(seg.timestamp)} --> ${formatSrtTimestamp(cueEnd)}`);
    entries.push(
      hasSpeakerIdentity
        ? `${resolveSpeaker(seg, speakerMappings, recorderLabel)}: ${seg.text}`
        : seg.text
    );
    entries.push("");
  }
  return entries.join("\n");
}

function formatJson(note, segments, speakerMappings, { recorderLabel } = {}) {
  const merged = mergeSegments(normalizeSegmentTimestamps(segments, note));
  const { title, dateStr } = extractMetadata(note);

  const untimed = isUntimed(segments);
  const speakersSet = new Set();
  if (!untimed) {
    for (const seg of merged) speakersSet.add(resolveSpeaker(seg, speakerMappings, recorderLabel));
  }
  const knownDuration = note.audio_duration_seconds > 0 ? note.audio_duration_seconds : 0;
  // The source duration describes the entire upload. Appended live audio can extend it.
  const durationSeconds =
    knownDuration > 0 && !merged.some((seg) => seg.source)
      ? knownDuration
      : merged.reduce(
          (latest, seg) => Math.max(latest, seg.lastTimestamp, seg.endTimestamp ?? 0),
          knownDuration
        );

  return JSON.stringify(
    {
      metadata: {
        title,
        date: dateStr,
        duration_seconds: Math.round(durationSeconds),
        speaker_count: speakersSet.size,
        segment_count: merged.length,
      },
      speakers: [...speakersSet],
      segments: merged.map((seg) => ({
        speaker: untimed ? null : resolveSpeaker(seg, speakerMappings, recorderLabel),
        timestamp: seg.timestamp,
        text: seg.text,
      })),
    },
    null,
    2
  );
}

function formatMd(note, segments, speakerMappings, { recorderLabel } = {}) {
  const merged = mergeSegments(normalizeSegmentTimestamps(segments, note));
  const { title, dateStr, participants } = extractMetadata(note);

  const lines = [`# ${title}`, "", `**Date:** ${dateStr}`];
  if (participants.length)
    lines.push(`**${i18nMain.t("notes.editor.participants")}:** ${participants.join(", ")}`);
  lines.push("", "---", "");
  const untimed = isUntimed(segments);
  for (const seg of merged) {
    if (!untimed) {
      lines.push(
        `**${resolveSpeaker(seg, speakerMappings, recorderLabel)}** \`${formatTimestamp(seg.timestamp)}\``
      );
    }
    lines.push(`${seg.text}`, "");
  }
  return lines.join("\n");
}

module.exports = {
  formatTxt,
  formatSrt,
  formatJson,
  formatMd,
  parseNoteDate,
  normalizeSegmentTimestamps,
};
