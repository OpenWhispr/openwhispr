const { i18nMain } = require("./i18nMain");
const { isAudioPolicyRefusal } = require("./audioPolicyRefusals");
const { POLICY_TIMEOUT_MS } = require("./connectors/connectorIpc");

const FEATURE_BY_PURPOSE = {
  meeting: "meetingRecordingEnabled",
  upload: "audioUploadEnabled",
};

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

function createAudioFeaturePolicy({
  getPolicy,
  onBlocked = () => {},
  onChange = () => {},
  logger = null,
  lookupDeadlineMs = POLICY_TIMEOUT_MS,
}) {
  const jobs = new Map();
  let snapshot = null;
  // The meeting verdict onChange last reported, so listeners (detectors, the
  // tray) hear about a change rather than every refresh.
  let reportedMeetingVerdict;
  // The verdict work already running was allowed under, kept from a
  // credential change until its re-resolve answers: an account change cancels
  // that work itself, and a token rotation alone must not interrupt it.
  let retained = null;
  // Bumped by invalidate, so a lookup made for the previous credential never lands.
  let epoch = 0;
  // New work is gated on the current credential's verdict; work already
  // running keeps the one it started under until a newer verdict lands.
  const failure = (purpose) => audioFeatureFailure(snapshot, purpose);
  const activeFailure = (purpose) => audioFeatureFailure(snapshot ?? retained, purpose);

  function update(next) {
    if (
      snapshot?.authGeneration === next?.authGeneration &&
      Number.isSafeInteger(snapshot?.revision) &&
      next?.revision < snapshot.revision
    )
      return;
    const previous = snapshot ?? retained;
    snapshot = next;
    retained = null;
    for (const purpose of Object.keys(FEATURE_BY_PURPOSE)) {
      const denied = failure(purpose);
      if (!denied) continue;
      for (const job of jobs.values()) {
        if (job.purpose === purpose) job.controller.abort(denied);
      }
      if (!previous || !audioFeatureFailure(previous, purpose)) onBlocked(purpose, denied.code);
    }
    const meetingVerdict = failure("meeting")?.code ?? null;
    if (meetingVerdict !== reportedMeetingVerdict) {
      reportedMeetingVerdict = meetingVerdict;
      onChange();
    }
  }

  // Only a successful lookup replaces the snapshot: a failed one says nothing
  // new about the policy, and must not stop a meeting the snapshot allows.
  async function lookup(event, options) {
    const startedIn = epoch;
    try {
      const next = await getPolicy(event, options);
      if (next?.success && startedIn === epoch) update(next);
    } catch (error) {
      logger?.warn?.("Audio policy lookup failed", { error: error?.message });
    }
  }

  // With no usable snapshot, waits for one, but only as long as a policy
  // decision may take; the lookup still lands if it answers later.
  async function settle(event) {
    let timer;
    await Promise.race([
      lookup(event),
      new Promise((done) => {
        timer = setTimeout(done, lookupDeadlineMs);
      }),
    ]);
    clearTimeout(timer);
  }

  // Only a server refusal (it carries an HTTP status) can reveal a stale
  // snapshot; a local one was decided from the snapshot itself.
  function refreshOnRefusal(event, refusal) {
    if (!Number.isInteger(refusal?.status) || !isAudioPolicyRefusal(refusal)) return;
    void lookup(event, { refresh: true });
  }

  // A job aborted by a policy change answers with that refusal; one aborted
  // for any other reason (owner gone, account changed) was cancelled.
  const abortedResult = ({ signal }) => {
    if (!signal.aborted) return null;
    if (signal.reason?.success === false) return signal.reason;
    return {
      success: false,
      code: "AUDIO_OPERATION_CANCELLED",
      error: i18nMain.t("notes.upload.batchCancelled"),
    };
  };

  return {
    update,
    failure,
    activeFailure,
    refreshOnRefusal,
    // Starts made in main (hotkey, tray, calendar) can arrive before the first
    // policy broadcast; fetch it then rather than refuse on a policy that never
    // loaded. A failed fetch still fails closed without reporting a block.
    async resolve(purpose) {
      if (!snapshot?.success) await settle({});
      return failure(purpose);
    },
    // The credential changed: new work waits for its policy, while work
    // already running keeps the verdict it started under. The policy is
    // fetched now, unless the caller already knows it (a sign-out is a guest).
    invalidate(known) {
      retained = snapshot ?? retained;
      snapshot = null;
      epoch += 1;
      // Others may sync to the unresolved verdict meanwhile, so the next one
      // is always reported, even if it matches the last.
      reportedMeetingVerdict = undefined;
      if (known) update(known);
      else void lookup({});
    },
    // The account changed: nothing started for the previous one may finish,
    // nor keep the verdict it started under. Called after invalidate, which
    // would otherwise retain that verdict again.
    cancelJobs() {
      retained = null;
      for (const job of jobs.values()) job.controller.abort();
    },
    // The handler gets the job's signal, merged with the caller's own cancel
    // signal when one is given.
    async run(event, purpose, handler, { signal: cancelSignal } = {}) {
      const job = { purpose, controller: new AbortController() };
      jobs.set(event, job);
      const onDestroyed = () => job.controller.abort();
      event.sender?.once?.("destroyed", onDestroyed);
      try {
        // An unrestricted purpose never waits on the network. A held verdict
        // answers at once and is refreshed behind it.
        if (FEATURE_BY_PURPOSE[purpose]) {
          if (snapshot?.success) void lookup(event);
          else await settle(event);
          job.controller.signal.throwIfAborted();
          const denied = failure(purpose);
          if (denied) return denied;
        }
        job.controller.signal.throwIfAborted();
        const result = await handler(
          cancelSignal
            ? AbortSignal.any([job.controller.signal, cancelSignal])
            : job.controller.signal
        );
        refreshOnRefusal(event, result);
        return abortedResult(job.controller) || activeFailure(purpose) || result;
      } catch (error) {
        refreshOnRefusal(event, error);
        return (
          abortedResult(job.controller) ||
          activeFailure(purpose) || {
            success: false,
            error: error.message,
            code: typeof error.code === "string" ? error.code : "AUDIO_OPERATION_FAILED",
            // Main-side enterprise errors are translated by the renderer.
            ...(error.messageKey && {
              messageKey: error.messageKey,
              messageParams: error.messageParams,
            }),
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
