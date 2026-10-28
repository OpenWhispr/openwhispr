// Names live voice clusters from the meeting app's own speaking indicator. The
// live identifier splits the system channel into voices (speaker_N) but can
// only guess who they are; the meeting app shows which participant is talking.
// A cluster whose speech keeps lining up with one participant's speaking
// intervals takes that participant's display name. Kept free of electron
// imports so the voting rules stay unit-testable (pattern: diarizationPolicy).
//
// Times are wall-clock ms on both sides: the helper stamps app states with
// Date.now(), and ipcHandlers maps identifier windows onto the same clock.

// Window portions shorter than this are mostly the identifier's ±0.75 s
// padding rather than speech, and say little about who was talking.
const MIN_VOTE_WINDOW_MS = 400;
// The top participant must be speaking through at least half of a window
// portion and the runner-up through at most a quarter. Anything closer is
// crosstalk or a highlight that hasn't switched yet, and casts no vote: a
// missing label is recoverable, a wrong one isn't.
const MIN_WINDOW_COVERAGE = 0.5;
const MAX_RUNNER_UP_COVERAGE = 0.25;
// Naming needs 4 s of agreeing speech with 70 % of the cluster's votes on one
// participant, so a few mistimed highlights can't name a voice. Moving a name
// to someone else needs the same majority over the whole history.
const MIN_BIND_EVIDENCE_MS = 4_000;
const MIN_BIND_SHARE = 0.7;
// Identifier windows only look back seconds; older intervals just cost memory.
const INTERVAL_RETENTION_MS = 10 * 60_000;
// Captions name a speaker once their words are transcribed, well after the
// voice started. An estimate until a live call measures it.
const CAPTION_LAG_MS = 1_500;

const createMeetingSpeakerFusion = ({ lagMs = 0 } = {}) => {
  // participantId -> { name, isSelf }; cumulative, since gallery pages and
  // speaker view only show part of the roster at a time.
  const participants = new Map();
  // participantId -> [{ start, end, lag }], end null while still speaking.
  const intervals = new Map();
  let speaking = new Set();
  let currentLag = lagMs;
  let lastStateAt = -Infinity;
  // speakerId -> Map(participantId -> agreeing ms)
  const votes = new Map();
  // speakerId -> end of the last window portion this cluster voted with.
  const countedUntil = new Map();
  // speakerId -> { participantId, displayName, givenNames } for names the
  // fusion gave. givenNames keeps earlier ones too: the identifier holds an
  // utterance's first name until the utterance ends, so windows after a
  // rename still arrive with the old name and must not read as another
  // source's.
  const bindings = new Map();

  const openInterval = (participantId, at, lag) => {
    const list = intervals.get(participantId) || [];
    list.push({ start: at, end: null, lag });
    intervals.set(participantId, list);
  };

  const closeInterval = (participantId, at) => {
    const list = intervals.get(participantId);
    const open = list?.findLast((interval) => interval.end == null);
    if (open) open.end = at;
  };

  const prune = (now) => {
    const horizon = now - INTERVAL_RETENTION_MS;
    for (const [participantId, list] of intervals) {
      const kept = list.filter((interval) => interval.end == null || interval.end >= horizon);
      if (kept.length) intervals.set(participantId, kept);
      else intervals.delete(participantId);
    }
  };

  // The app shows a speaker after it hears them (its own debounce, a caption's
  // transcription, plus the helper's poll interval), so intervals are moved
  // back by their lag to line up with the audio they describe. A participant
  // carried from a layout to captions has two intervals that overlap once
  // shifted, so the total is capped at the window: speech counts once.
  const overlapMs = (participantId, start, end) => {
    let total = 0;
    for (const interval of intervals.get(participantId) || []) {
      const intervalStart = interval.start - interval.lag;
      const intervalEnd = (interval.end ?? Infinity) - interval.lag;
      total += Math.max(0, Math.min(end, intervalEnd) - Math.max(start, intervalStart));
    }
    return Math.min(total, end - start);
  };

  const castVote = (speakerId, start, end) => {
    const length = end - start;
    let best = null;
    let bestMs = 0;
    let runnerUpMs = 0;
    for (const participantId of intervals.keys()) {
      // Marked as the user after their intervals opened: still never a vote.
      if (participants.get(participantId)?.isSelf) continue;
      const ms = overlapMs(participantId, start, end);
      if (ms > bestMs) {
        runnerUpMs = bestMs;
        bestMs = ms;
        best = participantId;
      } else if (ms > runnerUpMs) {
        runnerUpMs = ms;
      }
    }

    if (
      !best ||
      bestMs / length < MIN_WINDOW_COVERAGE ||
      runnerUpMs / length > MAX_RUNNER_UP_COVERAGE
    ) {
      return;
    }

    const tally = votes.get(speakerId) || new Map();
    tally.set(best, (tally.get(best) || 0) + bestMs);
    votes.set(speakerId, tally);
  };

  const leadingParticipant = (speakerId) => {
    const tally = votes.get(speakerId);
    if (!tally?.size) return null;

    let total = 0;
    let best = null;
    let bestMs = 0;
    for (const [participantId, ms] of tally) {
      total += ms;
      if (ms > bestMs) {
        bestMs = ms;
        best = participantId;
      }
    }
    return { participantId: best, ms: bestMs, share: bestMs / total };
  };

  const resolveNaming = (speakerId, currentName, nameFromMeetingApp) => {
    const binding = bindings.get(speakerId);
    // The fusion only fills names in, never replaces one: a curated name beats
    // a meeting display name like "iPhone". The caller passes the voice's name
    // as it stands now, and whether that name is one the meeting app gave, so
    // a rename by the user (even to the app's own wording) releases the voice.
    if (currentName && (nameFromMeetingApp === false || !binding?.givenNames.has(currentName))) {
      bindings.delete(speakerId);
      return null;
    }

    const leader = leadingParticipant(speakerId);
    if (!leader || leader.ms < MIN_BIND_EVIDENCE_MS || leader.share < MIN_BIND_SHARE) {
      return null;
    }
    // One name per voice. A highlight that lags or sticks (a pinned video,
    // captions still showing the last speaker) lends its votes to whoever
    // talks under it; the participant's own voice holds the name, and the
    // other stays unnamed rather than wrong.
    for (const [otherId, other] of bindings) {
      if (otherId !== speakerId && other.participantId === leader.participantId) return null;
    }

    const displayName = participants.get(leader.participantId)?.name;
    if (!displayName) return null;
    if (binding?.participantId === leader.participantId && binding.displayName === displayName) {
      return null;
    }

    const givenNames = new Set(binding?.givenNames).add(displayName);
    bindings.set(speakerId, { participantId: leader.participantId, displayName, givenNames });
    return { speakerId, participantId: leader.participantId, displayName };
  };

  return {
    // state: { at, participants: [{ id, name, isSelf }], speakingIds: [id],
    // strategy }. An empty state (app closed, meeting window gone) ends every
    // interval.
    recordAppState: ({ at, participants: roster = [], speakingIds = [], strategy } = {}) => {
      if (!Number.isFinite(at)) return;
      // Wall clocks can step backwards (NTP); intervals must not.
      const stamp = Math.max(at, lastStateAt);
      lastStateAt = stamp;

      for (const { id, name, isSelf } of roster) {
        if (!id) continue;
        const known = participants.get(id);
        // Newly marked as the user: the votes they collected meanwhile go, and
        // so does a voice the fusion named after them (it can't be the user's).
        if (isSelf && known && !known.isSelf) {
          for (const tally of votes.values()) tally.delete(id);
          for (const [speakerId, binding] of bindings) {
            if (binding.participantId === id) bindings.delete(speakerId);
          }
        }
        participants.set(id, {
          name: name || known?.name || null,
          // Sticky: the signal that marks the user (Zoom's home window) can
          // close mid-meeting without the user becoming someone else.
          isSelf: !!isSelf || !!known?.isSelf,
        });
      }

      // The user's own tile lights up when they talk, which the mic channel
      // already covers; letting it vote could hand a remote voice their name.
      const next = new Set(
        speakingIds.filter((id) => participants.has(id) && !participants.get(id).isSelf)
      );
      for (const id of speaking) {
        if (!next.has(id)) closeInterval(id, stamp);
      }
      const lag = strategy === "captions" ? lagMs + CAPTION_LAG_MS : lagMs;
      // Captions and layouts lag differently: a speaker carried from one to
      // the other starts a new interval at the new lag.
      if (lag !== currentLag) {
        for (const id of speaking) closeInterval(id, stamp);
        speaking = new Set();
        currentLag = lag;
      }
      for (const id of next) {
        if (!speaking.has(id)) openInterval(id, stamp, lag);
      }
      speaking = next;
      prune(stamp);
    },

    // identification: { speakerId, displayName, nameFromMeetingApp, startTime,
    // endTime }, displayName being the voice's current name. Returns
    // { speakerId, participantId, displayName } when the cluster should be
    // (re)named, otherwise null.
    observeIdentification: ({
      speakerId,
      displayName = null,
      nameFromMeetingApp,
      startTime,
      endTime,
    } = {}) => {
      if (!speakerId || !Number.isFinite(startTime) || !Number.isFinite(endTime)) return null;

      // An ongoing utterance is re-identified about once a second with a
      // window that keeps its original start; only the part past what this
      // cluster already voted with is new evidence.
      const previousEnd = countedUntil.get(speakerId);
      const start = previousEnd == null ? startTime : Math.max(startTime, previousEnd);
      if (previousEnd == null || endTime > previousEnd) countedUntil.set(speakerId, endTime);
      if (endTime - start >= MIN_VOTE_WINDOW_MS) castVote(speakerId, start, endTime);

      return resolveNaming(speakerId, displayName, nameFromMeetingApp);
    },

    // The user named this voice: the participant it held can name another
    // voice straight away, without waiting for this one to speak again (its
    // next identification, carrying the user's name, keeps it theirs).
    release: (speakerId) => {
      bindings.delete(speakerId);
    },

    // Mirrors liveSpeakerIdentifier.recluster(): votes move to the kept
    // cluster, and a binding follows only when the identifier kept the name
    // the fusion gave (it never merges clusters with different names).
    applyMerges: (merges = []) => {
      for (const { keep, remove, displayName = null } of merges) {
        if (!keep || !remove || keep === remove) continue;

        const removedVotes = votes.get(remove);
        if (removedVotes) {
          const tally = votes.get(keep) || new Map();
          for (const [participantId, ms] of removedVotes) {
            tally.set(participantId, (tally.get(participantId) || 0) + ms);
          }
          votes.set(keep, tally);
          votes.delete(remove);
        }

        const removedEnd = countedUntil.get(remove);
        if (removedEnd != null) {
          countedUntil.set(keep, Math.max(countedUntil.get(keep) ?? removedEnd, removedEnd));
          countedUntil.delete(remove);
        }

        const own = [bindings.get(keep), bindings.get(remove)].find((binding) =>
          binding?.givenNames.has(displayName)
        );
        bindings.delete(remove);
        if (own) bindings.set(keep, own);
        else bindings.delete(keep);
      }
    },

    // Counts only — participant names stay out of logs.
    summarize: () => ({
      participants: participants.size,
      votingClusters: votes.size,
      namedClusters: bindings.size,
    }),
  };
};

module.exports = {
  MIN_VOTE_WINDOW_MS,
  MIN_WINDOW_COVERAGE,
  MAX_RUNNER_UP_COVERAGE,
  MIN_BIND_EVIDENCE_MS,
  MIN_BIND_SHARE,
  INTERVAL_RETENTION_MS,
  CAPTION_LAG_MS,
  createMeetingSpeakerFusion,
};
