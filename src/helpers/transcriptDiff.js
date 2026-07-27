function computeTranscriptDiff(oldTranscript, newTranscript) {
  const oldSegs = parseSegments(oldTranscript);
  const newSegs = parseSegments(newTranscript);

  if (oldSegs.length === 0 || newSegs.length === 0) {
    return { totalSegments: 0, changedSegments: 0, newSpeakerSplits: 0 };
  }

  const oldSpeakers = new Set(oldSegs.map((s) => s.speaker).filter(Boolean));
  const newSpeakers = new Set(newSegs.map((s) => s.speaker).filter(Boolean));
  const newSpeakerSplits = [...newSpeakers].filter((s) => !oldSpeakers.has(s)).length;

  let changedSegments = 0;
  const len = Math.min(oldSegs.length, newSegs.length);
  for (let i = 0; i < len; i++) {
    if (oldSegs[i].text !== newSegs[i].text || oldSegs[i].speaker !== newSegs[i].speaker) {
      changedSegments++;
    }
  }
  changedSegments += Math.abs(oldSegs.length - newSegs.length);

  return { totalSegments: newSegs.length, changedSegments, newSpeakerSplits };
}

function parseSegments(transcript) {
  if (!Array.isArray(transcript)) {
    if (typeof transcript === "string" && transcript.startsWith("[")) {
      try { return JSON.parse(transcript); } catch { return []; }
    }
    return [];
  }
  return transcript;
}

module.exports = { computeTranscriptDiff };
