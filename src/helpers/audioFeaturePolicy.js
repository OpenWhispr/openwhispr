const { i18nMain } = require("./i18nMain");

const FEATURE_BY_PURPOSE = {
  meeting: "meetingRecordingEnabled",
  upload: "audioUploadEnabled",
};

function audioFeatureFailure(snapshot, purpose) {
  if (!snapshot?.success || (snapshot.managed && !snapshot.policy)) {
    return {
      success: false,
      code: "POLICY_UNRESOLVABLE",
      error: i18nMain.t("common.policyUnresolved"),
    };
  }
  if (!snapshot.managed || snapshot.policy?.features?.[FEATURE_BY_PURPOSE[purpose]] !== false) {
    return null;
  }
  return {
    success: false,
    code:
      purpose === "meeting" ? "POLICY_MEETING_RECORDING_DISABLED" : "POLICY_AUDIO_UPLOAD_DISABLED",
    error: i18nMain.t(
      purpose === "meeting"
        ? "notes.meeting.restrictedByOrg"
        : "common.policyTranscriptionRestricted"
    ),
  };
}

function createAudioFeaturePolicy({ getPolicy, onBlocked = () => {} }) {
  const jobs = new Map();
  let snapshot = null;
  const failure = (purpose) => audioFeatureFailure(snapshot, purpose);

  function update(next) {
    if (
      snapshot?.authGeneration === next?.authGeneration &&
      Number.isSafeInteger(snapshot?.revision) &&
      next?.revision < snapshot.revision
    )
      return;
    const previous = snapshot;
    snapshot = next;
    for (const purpose of Object.keys(FEATURE_BY_PURPOSE)) {
      if (!failure(purpose)) continue;
      for (const job of jobs.values()) {
        if (job.purpose === purpose) job.controller.abort();
      }
      if (!previous || !audioFeatureFailure(previous, purpose)) onBlocked(purpose);
    }
  }

  return {
    update,
    failure,
    signalFor: (event) => jobs.get(event)?.controller.signal,
    cancelAll() {
      snapshot = null;
      for (const job of jobs.values()) job.controller.abort();
    },
    async run(event, purpose, handler) {
      const job = { purpose, controller: new AbortController() };
      jobs.set(event, job);
      const onDestroyed = () => job.controller.abort();
      event.sender?.once?.("destroyed", onDestroyed);
      try {
        const next = await getPolicy(event);
        job.controller.signal.throwIfAborted();
        update(next);
        const denied = failure(purpose);
        if (denied) return denied;
        job.controller.signal.throwIfAborted();
        const result = await handler();
        return (
          failure(purpose) ||
          (job.controller.signal.aborted
            ? { success: false, code: "AUDIO_OPERATION_CANCELLED", error: "Cancelled" }
            : result)
        );
      } catch (error) {
        return (
          failure(purpose) || {
            success: false,
            error: error.message,
            code: job.controller.signal.aborted
              ? "AUDIO_OPERATION_CANCELLED"
              : typeof error.code === "string"
                ? error.code
                : "AUDIO_OPERATION_FAILED",
          }
        );
      } finally {
        event.sender?.removeListener?.("destroyed", onDestroyed);
        jobs.delete(event);
      }
    },
  };
}

module.exports = { audioFeatureFailure, createAudioFeaturePolicy };
