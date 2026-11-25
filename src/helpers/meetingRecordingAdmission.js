const { meetingAttendeeVerdict, meetingAttendeeRefusalCode } = require("./meetingAttendeePolicy");
const {
  requiresParticipantNotification,
  requiresMeetingAdmission,
} = require("./meetingRecordingPolicy");

const cancelled = { success: false, code: "AUDIO_OPERATION_CANCELLED" };
const unverifiable = "POLICY_ATTENDEES_UNVERIFIABLE";
const noticeRequired = "POLICY_PARTICIPANT_NOTIFICATION_REQUIRED";

function createMeetingRecordingAdmission({
  getPolicy,
  resolveFeature,
  getNote,
  getEvent,
  generation,
  confirmInternal,
  confirmNotification,
  onRevoked,
}) {
  const pending = new Map();
  let active = null;

  function readInvite(noteId) {
    if (noteId === null) return { eventId: null };
    try {
      const note = getNote(noteId);
      if (note) return { eventId: note.calendar_event_id || null };
    } catch {
      // A linked note that cannot be read must never become an in-person meeting.
    }
    return null;
  }

  function newAttempt(owner, { noteId = null, sessionId }) {
    return {
      owner,
      noteId,
      sessionId,
      generation: generation(),
      // Pin the original event even if blocking is turned on later in the call.
      eventId: readInvite(noteId)?.eventId ?? null,
      confirmed: false,
      notificationMethod: null,
      approved: false,
      refusal: null,
    };
  }

  function verdict(attempt) {
    const meetings = getPolicy();
    if ((meetings?.externalAttendees ?? "allowed") === "allowed") return "allow";
    const link = readInvite(attempt.noteId);
    if (!link || (link.eventId && attempt.eventId && link.eventId !== attempt.eventId)) {
      return "unverifiable";
    }
    attempt.eventId ||= link.eventId;
    if (!attempt.eventId) return "confirm";
    const event = getEvent(attempt.eventId);
    return event ? meetingAttendeeVerdict(event, meetings) : "unverifiable";
  }

  function refusal(attempt) {
    const decision = verdict(attempt);
    if (decision === "allow" || (decision === "confirm" && attempt.confirmed)) return null;
    return meetingAttendeeRefusalCode(decision) ?? unverifiable;
  }

  function release(owner, sessionId) {
    const attempt = pending.get(owner);
    if (!attempt || attempt.sessionId !== sessionId) return;
    pending.delete(owner);
    owner.removeListener?.("destroyed", attempt.lost);
    owner.removeListener?.("render-process-gone", attempt.lost);
    owner.removeListener?.("did-start-navigation", attempt.navigated);
    attempt.controller.abort();
  }

  async function prepare(owner, options) {
    if (
      !owner ||
      typeof options?.sessionId !== "string" ||
      !options.sessionId ||
      (options.noteId != null && !Number.isSafeInteger(options.noteId))
    )
      return cancelled;
    const previous = pending.get(owner);
    if (previous) release(owner, previous.sessionId);
    const attempt = newAttempt(owner, options);
    const controller = new AbortController();
    attempt.controller = controller;
    attempt.lost = () => release(owner, attempt.sessionId);
    attempt.navigated = (details) => {
      if (details?.isMainFrame && !details.isSameDocument) attempt.lost();
    };
    owner.once?.("destroyed", attempt.lost);
    owner.once?.("render-process-gone", attempt.lost);
    owner.on?.("did-start-navigation", attempt.navigated);
    pending.set(owner, attempt);
    const current = () => !controller.signal.aborted && attempt.generation === generation();
    try {
      const denied = await resolveFeature();
      if (!current()) return cancelled;
      if (denied) return denied;
      if (verdict(attempt) === "confirm") {
        attempt.confirmed = await confirmInternal(owner, controller.signal);
        if (!current() || !attempt.confirmed) return cancelled;
        // The feature may have been switched off while the native sheet was open.
        const updatedFailure = await resolveFeature();
        if (!current()) return cancelled;
        if (updatedFailure) return updatedFailure;
      }
      const code = refusal(attempt);
      if (code) return { success: false, code };
      if (requiresParticipantNotification(getPolicy())) {
        const told = await confirmNotification(owner, controller.signal);
        if (!current() || !told) return cancelled;
        const deniedAfterNotice = await resolveFeature();
        if (!current()) return cancelled;
        if (deniedAfterNotice) return deniedAfterNotice;
        const attendeeRefusal = refusal(attempt);
        if (attendeeRefusal) return { success: false, code: attendeeRefusal };
        attempt.notificationMethod = "told-by-member";
      }
      attempt.approved = true;
      return attempt.notificationMethod
        ? { success: true, notificationMethod: attempt.notificationMethod }
        : { success: true };
    } finally {
      if (!attempt.approved && pending.get(owner) === attempt) release(owner, attempt.sessionId);
    }
  }

  function checkStart(owner, options) {
    const attempt = pending.get(owner);
    const matches =
      attempt?.approved &&
      attempt.sessionId === options.sessionId &&
      attempt.noteId === (options.noteId ?? null) &&
      attempt.generation === generation();
    const recording = matches ? attempt : newAttempt(owner, options);
    const code = refusal(recording);
    if (code) return { success: false, code };
    if (requiresParticipantNotification(getPolicy()) && !recording.notificationMethod)
      return { success: false, code: noticeRequired };
    if (!matches && (getPolicy()?.externalAttendees ?? "allowed") !== "allowed") {
      return { success: false, code: unverifiable };
    }
    return { success: true, recording };
  }

  function start(owner, options) {
    const decision = checkStart(owner, options);
    if (!decision.success) return decision;
    release(owner, options.sessionId);
    active = decision.recording;
    return { success: true, notificationMethod: active.notificationMethod };
  }

  function recheck(noteId) {
    for (const attempt of [...pending.values(), active]) {
      if (!attempt || attempt.refusal || (!attempt.approved && attempt !== active)) continue;
      if (noteId !== undefined && noteId !== attempt.noteId) continue;
      // This policy governs starts. A change while waiting for capture must
      // invalidate the approval, even if the invite still allows recording.
      const missingNotice =
        attempt !== active &&
        requiresParticipantNotification(getPolicy()) &&
        !attempt.notificationMethod;
      const code = refusal(attempt) ?? (missingNotice ? noticeRequired : null);
      if (!code) continue;
      attempt.refusal = code;
      if (attempt !== active) release(attempt.owner, attempt.sessionId);
      onRevoked(attempt, code, attempt === active);
    }
  }

  return {
    prepare,
    checkStart,
    start,
    release,
    recheck,
    cancelPending() {
      for (const attempt of pending.values()) {
        release(attempt.owner, attempt.sessionId);
        if (attempt.approved && requiresMeetingAdmission(getPolicy()))
          onRevoked(attempt, cancelled.code, false);
      }
    },
    activeRefusal: () => active?.refusal ?? null,
    end(sessionId) {
      if (active?.sessionId === sessionId) active = null;
    },
  };
}

module.exports = { createMeetingRecordingAdmission };
