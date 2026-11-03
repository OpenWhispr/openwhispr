const { AsyncLocalStorage } = require("node:async_hooks");
const { isValidPolicyShape } = require("./policyValidation");

const operationContext = new AsyncLocalStorage();
const LOCAL_POLICY_CODES = new Set([
  "POLICY_MODEL_BLOCKED",
  "POLICY_LOCAL_MODE_BLOCKED",
  "POLICY_UNRESOLVABLE",
  "POLICY_APP_VERSION_BLOCKED",
]);

function isLocalModelPolicyRefusal(error) {
  return LOCAL_POLICY_CODES.has(error?.code);
}

function policyError(code) {
  const keys = {
    POLICY_MODEL_BLOCKED: "models.policy.modelBlocked",
    POLICY_LOCAL_MODE_BLOCKED: "models.policy.modeBlocked",
    POLICY_UNRESOLVABLE: "models.policy.unresolved",
    POLICY_APP_VERSION_BLOCKED: "models.policy.versionBlocked",
  };
  const { i18nMain } = require("./i18nMain");
  return Object.assign(new Error(i18nMain.t(keys[code])), { code });
}

// A verdict that says what is allowed: a failed lookup or an unreadable policy
// doesn't, so it can refuse new work but never revokes running work.
function isResolvedVerdict(verdict) {
  return verdict?.success === true && (!verdict.managed || isValidPolicyShape(verdict.policy));
}

/** Main owns identity and policy lookup; renderer arguments never establish unmanaged status. */
function createLocalModelPolicyGate({
  getPolicy,
  getHeldPolicy,
  getIdentity,
  getAppVersion,
  isSnapshotCurrent = () => true,
  onChange = () => {},
}) {
  let snapshot = null;
  let snapshotIdentity;
  // The verdict running work was allowed under, kept from a credential change
  // until its re-resolve answers: a token rotation must not interrupt that
  // work, and only an account change (cancelJobs) ends it.
  let retained = null;
  // Bumped by invalidate, so a lookup made for the previous credential never lands.
  let epoch = 0;
  let rules;
  let pendingLookup = null;
  let warmUpsAwaitingVerdict = [];
  const leases = new Set();

  function verdictFailure(verdict, scope, modelId) {
    if (!isResolvedVerdict(verdict) || !rules) return policyError("POLICY_UNRESOLVABLE");
    const isBlank = typeof modelId !== "string" || modelId.trim().length === 0;
    if (!isBlank && !rules.isKnownLocalModelId(scope, modelId))
      return new Error(`Unknown local model: ${modelId}`);
    // With nothing managing this user a blank model is the engine's default,
    // as it always was; only a managed policy has to know the exact model.
    if (isBlank && !verdict.managed) return null;
    const state = {
      status: verdict.managed ? "managed" : "unmanaged",
      policy: verdict.policy ?? null,
      appVersion: getAppVersion(),
    };
    if (!rules.isPolicyActionAllowed(state)) return policyError("POLICY_APP_VERSION_BLOCKED");
    if (!rules.isModeAllowedByPolicy(state, scope, "local"))
      return policyError("POLICY_LOCAL_MODE_BLOCKED");
    if (!rules.isLocalModelAllowedByPolicy(state, scope, modelId))
      return policyError("POLICY_MODEL_BLOCKED");
    return null;
  }

  const hasCurrentVerdict = () => snapshotIdentity === getIdentity() && isResolvedVerdict(snapshot);

  // New work needs the current credential's verdict.
  const failure = (scope, modelId) =>
    verdictFailure(snapshotIdentity === getIdentity() ? snapshot : null, scope, modelId);

  // Work already running keeps the verdict it started under until a newer one lands.
  const activeVerdict = () => (isResolvedVerdict(snapshot) ? snapshot : retained);

  function runWarmUpsAwaitingVerdict() {
    const warmUps = warmUpsAwaitingVerdict;
    warmUpsAwaitingVerdict = [];
    for (const warmUp of warmUps) warmUp();
  }

  async function loadRules() {
    rules ??= await import("../stores/policyRules.ts");
  }

  function applyVerdict() {
    if (!hasCurrentVerdict()) return;
    for (const lease of leases) {
      const denied = failure(lease.scope, lease.modelId);
      if (denied) lease.controller.abort(denied);
    }
    onChange();
    runWarmUpsAwaitingVerdict();
  }

  function update(next) {
    const identity = getIdentity();
    if (!isSnapshotCurrent(next)) return;
    if (next?.authGeneration !== undefined && next.authGeneration !== identity) return;
    if (
      snapshotIdentity === identity &&
      Number.isSafeInteger(snapshot?.revision) &&
      next?.revision < snapshot.revision
    )
      return;
    if (!isResolvedVerdict(next)) {
      // A failed lookup says nothing new about the policy. The server calling
      // it unresolvable does refuse new work, but it names no model to stop.
      if (next?.success || next?.code === "POLICY_UNRESOLVABLE") {
        retained = activeVerdict();
        snapshot = next;
        snapshotIdentity = identity;
      }
      return;
    }
    // The same verdict again, as every lookup answers within the freshness window.
    if (
      snapshotIdentity === identity &&
      isResolvedVerdict(snapshot) &&
      Number.isSafeInteger(next.revision) &&
      next.revision === snapshot.revision
    )
      return;
    snapshot = next;
    snapshotIdentity = identity;
    retained = null;
    // A verdict can land before anything needed the rules; until they load it
    // can't be read, and an unread verdict must not look like a denial.
    if (rules) applyVerdict();
    // New work stays refused if they can't load; there's nothing else to tell it.
    else loadRules().then(applyVerdict, () => {});
  }

  // Answers one at a time; only a refresh, which must reach the policy manager
  // with its flag, doesn't join a lookup already in flight.
  function lookup({ refresh = false } = {}) {
    if (pendingLookup && !refresh) return pendingLookup;
    const startedEpoch = epoch;
    const identity = getIdentity();
    const pending = (async () => {
      try {
        const next = await getPolicy({ refresh });
        if (epoch === startedEpoch && identity === getIdentity()) update(next);
      } catch {
        // Says nothing new: a held verdict stands, and with none work is refused.
      }
    })().finally(() => {
      if (pendingLookup === pending) pendingLookup = null;
    });
    pendingLookup = pending;
    return pending;
  }

  // A verdict kept on disk is still a held verdict; the network only refreshes it.
  async function adoptHeldVerdict() {
    if (!getHeldPolicy) return;
    const startedEpoch = epoch;
    const identity = getIdentity();
    try {
      const held = await getHeldPolicy();
      if (epoch === startedEpoch && identity === getIdentity()) update(held);
    } catch {
      // Nothing held: the lookup decides.
    }
  }

  function assertCurrent(lease) {
    lease.signal.throwIfAborted();
    const denied = verdictFailure(activeVerdict(), lease.scope, lease.modelId);
    if (denied) throw denied;
  }

  function authorizeCached(scope, modelId) {
    const denied = failure(scope, modelId);
    if (denied) throw denied;
    const controller = new AbortController();
    const lease = { scope, modelId, controller, signal: controller.signal };
    leases.add(lease);
    return lease;
  }

  return {
    failure,
    update,
    assertCurrent,
    authorizeCached,
    // The credential changed: new work waits for its verdict, while work
    // already running and loaded servers keep the one they have until it lands.
    // The verdict is fetched now, unless the caller already knows it (a
    // sign-out is a guest).
    invalidate(known) {
      retained = activeVerdict();
      snapshot = null;
      epoch++;
      pendingLookup = null;
      if (known) update(known);
      else void lookup();
    },
    // The account changed: nothing started for the previous one may finish,
    // nor may its verdict decide anything further. Call before invalidate.
    cancelJobs() {
      snapshot = null;
      retained = null;
      for (const lease of leases) lease.controller.abort(policyError("POLICY_UNRESOLVABLE"));
    },
    // A background warm-up refused because nothing has settled runs once, when
    // the first verdict lands; a denial then refuses it the ordinary way.
    runOnceVerdictSettles(warmUp) {
      if (hasCurrentVerdict()) warmUp();
      else warmUpsAwaitingVerdict.push(warmUp);
    },
    // A held verdict answers at once and is refreshed behind it, so a slow
    // network never holds up dictation; only an identity with no verdict
    // waits. A denial from the refresh revokes through update. `refresh` asks
    // the policy manager past its freshness window, and waits for the answer.
    async resolve({ memoryOnly = false, refresh = false } = {}) {
      const identity = getIdentity();
      await loadRules();
      if (!memoryOnly) {
        if (!hasCurrentVerdict() && !refresh) await adoptHeldVerdict();
        if (hasCurrentVerdict() && !refresh) void lookup();
        else {
          const startedEpoch = epoch;
          await lookup({ refresh });
          // invalidate replaced that lookup for this same credential; its
          // answer is the one to wait for, unless it has already landed.
          if (epoch !== startedEpoch && identity === getIdentity() && !hasCurrentVerdict())
            await lookup();
        }
        if (identity !== getIdentity()) throw policyError("POLICY_UNRESOLVABLE");
      }
      if (!hasCurrentVerdict()) throw policyError("POLICY_UNRESOLVABLE");
    },
    // Runs an operation as part of work already holding this lease, so nested
    // engine calls reuse its verdict rather than asking for a new one.
    runWithLease(lease, operation) {
      return operationContext.run({ gate: this, lease }, operation);
    },
    async authorize(scope, modelId, options = {}) {
      await this.resolve(options);
      return authorizeCached(scope, modelId);
    },
    release(lease) {
      leases.delete(lease);
    },
    startPeriodicRefresh(intervalMs) {
      const timer = setInterval(() => {
        void this.resolve({ refresh: true }).catch(() => {});
      }, intervalMs);
      timer.unref?.();
      return timer;
    },
  };
}

/** Nested engine calls reuse an operation's lease, including retries, without another lookup. */
async function runLocalModelOperation(owner, scope, modelId, operation, options = {}) {
  const gate = owner.localModelPolicy;
  if (!gate) return operation();
  const current = operationContext.getStore();
  if (
    current?.gate === gate &&
    current.lease.scope === scope &&
    current.lease.modelId === modelId
  ) {
    gate.assertCurrent(current.lease);
    return operation();
  }
  const lease = await gate.authorize(scope, modelId, options);
  const cancel = () => {
    Promise.resolve(options.onAbort?.(lease.signal.reason)).catch(() => {});
  };
  lease.signal.addEventListener("abort", cancel, { once: true });
  try {
    return await operationContext.run({ gate, lease }, async () => {
      gate.assertCurrent(lease);
      try {
        const result = await operation(lease.signal);
        gate.assertCurrent(lease);
        return result;
      } catch (error) {
        gate.assertCurrent(lease);
        throw error;
      }
    });
  } finally {
    lease.signal.removeEventListener("abort", cancel);
    gate.release(lease);
  }
}

function assertLocalModelOperation(owner) {
  if (!owner.localModelPolicy) return;
  const current = operationContext.getStore();
  if (current?.gate !== owner.localModelPolicy) throw policyError("POLICY_UNRESOLVABLE");
  current.gate.assertCurrent(current.lease);
}

function localModelOperationSignal(owner, signal) {
  if (!owner.localModelPolicy) return signal;
  assertLocalModelOperation(owner);
  const policySignal = operationContext.getStore().lease.signal;
  return signal ? AbortSignal.any([signal, policySignal]) : policySignal;
}

/**
 * Stops a transfer when its operation's lease is revoked. Transfers run on
 * createDownloadSignal's plain signal, which downloadFile polls and whose
 * onAbort it replaces per attempt, so the lease reaches it through the
 * download's own abort. Returns the unbind for the transfer's finally.
 */
function bindLocalModelDownload(owner, abort) {
  if (!owner.localModelPolicy) return () => {};
  assertLocalModelOperation(owner);
  const { signal } = operationContext.getStore().lease;
  signal.addEventListener("abort", abort, { once: true });
  return () => signal.removeEventListener("abort", abort);
}

module.exports = {
  createLocalModelPolicyGate,
  isLocalModelPolicyRefusal,
  policyError,
  runLocalModelOperation,
  assertLocalModelOperation,
  localModelOperationSignal,
  bindLocalModelDownload,
};
