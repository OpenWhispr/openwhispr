function splitIntoSentences(text) {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function formatTimestamp(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

function mergeSpeakersWithText(segments, text, durationSeconds) {
  if (!segments || segments.length === 0) {
    return [{ speaker: "speaker_0", text, start: 0, end: durationSeconds || 0 }];
  }

  const sentences = splitIntoSentences(text);
  if (sentences.length === 0) {
    return [{ speaker: segments[0].speaker, text, start: segments[0].start, end: segments[segments.length - 1].end }];
  }

  const totalDuration = durationSeconds || segments[segments.length - 1].end || 1;
  const totalChars = sentences.reduce((sum, s) => sum + s.length, 0);

  const assigned = [];
  let charOffset = 0;

  for (const sentence of sentences) {
    const sentenceMidpoint = ((charOffset + sentence.length / 2) / totalChars) * totalDuration;
    charOffset += sentence.length;

    let bestSegment = segments[0];
    for (const seg of segments) {
      if (sentenceMidpoint >= seg.start && sentenceMidpoint < seg.end) {
        bestSegment = seg;
        break;
      }
    }

    assigned.push({
      speaker: bestSegment.speaker,
      text: sentence,
      start: bestSegment.start,
      end: bestSegment.end,
    });
  }

  const consolidated = [];
  for (const item of assigned) {
    const prev = consolidated[consolidated.length - 1];
    if (prev && prev.speaker === item.speaker) {
      prev.text += " " + item.text;
      prev.end = Math.max(prev.end, item.end);
    } else {
      consolidated.push({ ...item });
    }
  }

  return consolidated;
}

function formatSpeakerTranscript(mergedSegments) {
  const speakerMap = new Map();
  let nextIndex = 1;

  return mergedSegments
    .map((seg) => {
      if (!speakerMap.has(seg.speaker)) {
        speakerMap.set(seg.speaker, nextIndex++);
      }
      const label = `Speaker ${speakerMap.get(seg.speaker)}`;
      const timeRange = `${formatTimestamp(seg.start)} - ${formatTimestamp(seg.end)}`;
      return `[${label}] ${timeRange}\n${seg.text}`;
    })
    .join("\n\n");
}

module.exports = { mergeSpeakersWithText, formatSpeakerTranscript, splitIntoSentences, formatTimestamp };
