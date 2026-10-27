const { i18nMain } = require("./i18nMain");

const FEATURE_BY_PURPOSE = {
  meeting: "meetingRecordingEnabled",
  upload: "audioUploadEnabled",
};

// The server's refusals of an audio purpose. Each also means the snapshot that
// let the request through no longer matches the org's policy.
const AUDIO_POLICY_REFUSAL_CODES = new Set([
  "POLICY_MEETING_RECORDING_DISABLED",
  "POLICY_AUDIO_UPLOAD_DISABLED",
  "AUDIO_PURPOSE_REQUIRED",
  "POLICY_UNRESOLVABLE",
]);

const isAudioPolicyRefusal = (failure) => AUDIO_POLICY_REFUSAL_CODES.has(failure?.code);

function audioFeatureFailure(snapshot, purpose) {
  // Dictation is never restricted by these controls, so an unloaded policy
  // must not refuse it either.
  if (!FEATURE_BY_PURPOSE[purpose]) return null;
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
      purpose === "meeting" ? "notes.meeting.recordingDisabledByOrg" : "notes.upload.disabledByOrg"
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
      const denied = failure(purpose);
      if (!denied) continue;
      for (const job of jobs.values()) {
        if (job.purpose === purpose) job.controller.abort();
      }
      if (!previous || !audioFeatureFailure(previous, purpose)) onBlocked(purpose, denied.code);
    }
  }

  // Only a server refusal (it carries an HTTP status) can reveal a stale
  // snapshot; a local one was decided from the snapshot itself.
  function refreshOnRefusal(event, refusal) {
    if (!Number.isInteger(refusal?.status) || !isAudioPolicyRefusal(refusal)) return;
    void getPolicy(event, { refresh: true }).then(update, () => {});
  }

  return {
    update,
    failure,
    refreshOnRefusal,
    signalFor: (event) => jobs.get(event)?.controller.signal,
    // Starts made in main (hotkey, tray, calendar) can arrive before the first
    // policy broadcast; fetch it then rather than refuse on a policy that never
    // loaded. Only a usable answer replaces the snapshot, so a failed fetch
    // still fails closed without reporting a block.
    async resolve(purpose) {
      if (!snapshot) {
        const next = await getPolicy({}).catch(() => null);
        if (next?.success) update(next);
      }
      return failure(purpose);
    },
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
        // An unrestricted purpose must not wait on the network, nor feed a
        // failed lookup into update(), which can stop a live meeting.
        if (FEATURE_BY_PURPOSE[purpose]) {
          const next = await getPolicy(event);
          job.controller.signal.throwIfAborted();
          update(next);
          const denied = failure(purpose);
          if (denied) return denied;
        }
        job.controller.signal.throwIfAborted();
        const result = await handler();
        refreshOnRefusal(event, result);
        return (
          failure(purpose) ||
          (job.controller.signal.aborted
            ? { success: false, code: "AUDIO_OPERATION_CANCELLED", error: "Cancelled" }
            : result)
        );
      } catch (error) {
        refreshOnRefusal(event, error);
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

module.exports = {
  AUDIO_POLICY_REFUSAL_CODES,
  audioFeatureFailure,
  createAudioFeaturePolicy,
  isAudioPolicyRefusal,
};
