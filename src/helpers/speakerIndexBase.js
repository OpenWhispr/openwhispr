// Speaker ids (`speaker_N`) key a note's speaker mappings, embeddings and locks.
// A resumed recording ("record more") appends to a note that already holds an
// earlier session's ids, so its own ids start past every index the note uses —
// otherwise a new voice would inherit the earlier person's name and lock.

function speakerIndexOf(speakerId) {
  if (typeof speakerId !== "string") return null;
  const match = /^speaker_(\d+)$/.exec(speakerId);
  return match ? Number(match[1]) : null;
}

function normalizeSpeakerIndexBase(value) {
  const base = Number(value);
  return Number.isSafeInteger(base) && base > 0 ? base : 0;
}

// The first index free of both the requested base and every id already in use.
function resolveSpeakerIndexBase(requested, speakerIds) {
  let base = normalizeSpeakerIndexBase(requested);
  for (const speakerId of speakerIds) {
    const index = speakerIndexOf(speakerId);
    if (index != null && index + 1 > base) base = index + 1;
  }
  return base;
}

// Diarization clusters are renumbered in first-seen order from the session's base.
function buildSpeakerRenumber(clusterIds, speakerIndexBase) {
  const base = normalizeSpeakerIndexBase(speakerIndexBase);
  const renumber = new Map();
  for (const clusterId of clusterIds) {
    renumber.set(clusterId, `speaker_${base + renumber.size}`);
  }
  return renumber;
}

module.exports = {
  speakerIndexOf,
  normalizeSpeakerIndexBase,
  resolveSpeakerIndexBase,
  buildSpeakerRenumber,
};
