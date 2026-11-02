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

/** Main owns identity and policy lookup; renderer arguments never establish unmanaged status. */
function createLocalModelPolicyGate({
  getPolicy,
  getIdentity,
  getAppVersion,
  isSnapshotCurrent = () => true,
  onChange = () => {},
}) {
  let snapshot = null;
  let snapshotIdentity;
  let epoch = 0;
  let rules;
  const leases = new Set();

  function failure(scope, modelId) {
    if (
      !snapshot?.success ||
      snapshotIdentity !== getIdentity() ||
      !rules ||
      (snapshot.managed && !isValidPolicyShape(snapshot.policy))
    ) {
      return policyError("POLICY_UNRESOLVABLE");
    }
    const state = {
      status: snapshot.managed ? "managed" : "unmanaged",
      policy: snapshot.policy ?? null,
      appVersion: getAppVersion(),
    };
    if (
      typeof modelId === "string" &&
      modelId.trim().length > 0 &&
      !rules.isKnownLocalModelId(scope, modelId)
    )
      return new Error(`Unknown local model: ${modelId}`);
    if (!rules.isPolicyActionAllowed(state)) return policyError("POLICY_APP_VERSION_BLOCKED");
    if (!rules.isModeAllowedByPolicy(state, scope, "local"))
      return policyError("POLICY_LOCAL_MODE_BLOCKED");
    if (!rules.isLocalModelAllowedByPolicy(state, scope, modelId))
      return policyError("POLICY_MODEL_BLOCKED");
    return null;
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
    snapshot = next;
    snapshotIdentity = identity;
    for (const lease of leases) {
      const denied =
        lease.identity !== identity
          ? policyError("POLICY_UNRESOLVABLE")
          : failure(lease.scope, lease.modelId);
      if (denied) lease.controller.abort(denied);
    }
    onChange();
  }

  function assertCurrent(lease) {
    lease.signal.throwIfAborted();
    const denied =
      lease.epoch !== epoch || lease.identity !== getIdentity()
        ? policyError("POLICY_UNRESOLVABLE")
        : failure(lease.scope, lease.modelId);
    if (denied) throw denied;
  }

  function authorizeCached(scope, modelId) {
    const denied = failure(scope, modelId);
    if (denied) throw denied;
    const controller = new AbortController();
    const lease = {
      scope,
      modelId,
      epoch,
      identity: getIdentity(),
      controller,
      signal: controller.signal,
    };
    leases.add(lease);
    return lease;
  }

  return {
    failure,
    update,
    assertCurrent,
    authorizeCached,
    invalidate(known) {
      epoch++;
      snapshot = null;
      for (const lease of leases) lease.controller.abort(policyError("POLICY_UNRESOLVABLE"));
      if (known) update(known);
      else onChange();
    },
    async resolve({ memoryOnly = false } = {}) {
      const startedEpoch = epoch;
      const identity = getIdentity();
      rules ??= await import("../stores/policyRules.ts");
      if (!memoryOnly) {
        let next;
        try {
          next = await getPolicy();
        } catch {
          if (epoch === startedEpoch && identity === getIdentity()) update({ success: false });
          throw policyError("POLICY_UNRESOLVABLE");
        }
        if (epoch !== startedEpoch || identity !== getIdentity())
          throw policyError("POLICY_UNRESOLVABLE");
        update(next);
      }
      if (!snapshot?.success || snapshotIdentity !== getIdentity())
        throw policyError("POLICY_UNRESOLVABLE");
    },
    async authorize(scope, modelId, options = {}) {
      await this.resolve(options);
      return authorizeCached(scope, modelId);
    },
    release(lease) {
      leases.delete(lease);
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

module.exports = {
  createLocalModelPolicyGate,
  isLocalModelPolicyRefusal,
  policyError,
  runLocalModelOperation,
  assertLocalModelOperation,
  localModelOperationSignal,
};
