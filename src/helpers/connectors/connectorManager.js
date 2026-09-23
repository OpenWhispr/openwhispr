const crypto = require("crypto");

const CANCEL_REASONS = new Set(["cancelled_by_user", "conversation_ended", "expired"]);

function policyRefusal(policyState) {
  if (policyState === "allowed") return null;
  return policyState === "blocked" ? "policy_blocked" : "policy_unavailable";
}

function sanitizeEdits(edits) {
  const clean = {};
  if (edits && typeof edits.title === "string") clean.title = edits.title;
  if (edits && typeof edits.body === "string") clean.body = edits.body;
  return clean;
}

function createConnectorManager({
  connectors,
  pendingActions,
  actionLog,
  logger,
  randomId = () => crypto.randomBytes(16).toString("hex"),
}) {
  const byId = new Map(connectors.map((connector) => [connector.id, connector]));

  // Writes before a side effect gate it: without a durable row, a crash
  // mid-send could hide a message that was actually sent.
  function writeRequired(step, write) {
    try {
      return write() !== false;
    } catch (error) {
      logger.error("connector receipt write failed", { step, error: error.message });
      return false;
    }
  }

  // Writes after the outcome is known are best effort: a failure leaves the
  // row in its last durable state, which reconciliation treats conservatively.
  function record(write) {
    try {
      write();
    } catch (error) {
      logger.warn("connector receipt update failed", { error: error.message }, "connectors");
    }
  }

  record(() => {
    const reconciled = actionLog.reconcileInterrupted();
    if (reconciled.unknown || reconciled.cancelled) {
      logger.info("reconciled interrupted connector actions", reconciled, "connectors");
    }
  });

  function resolveAction(connectorId, action, kind) {
    const connector = byId.get(connectorId);
    if (!connector) return { error: "unknown_connector" };
    if (connector.actions[action]?.kind !== kind) return { error: "unknown_action" };
    return { connector };
  }

  async function status() {
    return Promise.all(
      [...byId.values()].map(async (connector) => ({ id: connector.id, ...(await connector.getStatus()) }))
    );
  }

  async function prepare(connectorId, action, args, policyState) {
    const refusal = policyRefusal(policyState);
    if (refusal) return { status: "unavailable", reason: refusal };
    const resolved = resolveAction(connectorId, action, "approval");
    if (resolved.error) return { status: "unavailable", reason: resolved.error };
    const { connector } = resolved;

    const binding = await connector.getBinding();
    if (!binding) return { status: "unavailable", reason: "not_connected" };

    let prepared;
    try {
      prepared = await connector.prepare(action, args || {});
    } catch (error) {
      logger.warn("connector prepare threw", { connectorId, action, error: error.message }, "connectors");
      return { status: "failed", errorCode: "prepare_failed", message: "Couldn't prepare that action." };
    }
    if (prepared.status !== "ready") return prepared;

    const actionId = pendingActions.create({
      connectorId,
      action,
      binding,
      payload: prepared.payload,
      preview: prepared.preview,
    });
    const recorded = writeRequired("pending", () => {
      actionLog.insert({
        id: actionId,
        connector: connectorId,
        action,
        kind: "approval",
        destinationLabel: prepared.preview.destinationLabel,
        state: "pending",
      });
    });
    if (!recorded) {
      pendingActions.cancel(actionId);
      return {
        status: "failed",
        errorCode: "receipt_unavailable",
        message: "Couldn't record this action, so nothing was prepared.",
      };
    }
    return { status: "ready", actionId, preview: prepared.preview };
  }

  async function commit(actionId, edits, policyState) {
    const entry = pendingActions.get(actionId);
    if (!entry) return { state: "not_sent", reason: "not_found" };
    // A second click while the first is sending must neither send nor
    // overwrite the in-flight row.
    if (entry.state !== "pending") return { state: "not_sent", reason: "not_pending" };

    const refusal = policyRefusal(policyState);
    if (refusal) {
      pendingActions.cancel(actionId);
      record(() => actionLog.update(actionId, { state: "cancelled", errorCode: refusal }));
      return { state: "not_sent", reason: refusal };
    }

    const connector = byId.get(entry.connectorId);
    const begun = pendingActions.beginCommit(actionId, await connector.getBinding());
    if (!begun.ok) {
      if (begun.reason !== "not_pending") {
        const state = begun.reason === "expired" ? "expired" : "cancelled";
        record(() => actionLog.update(actionId, { state, errorCode: begun.reason }));
      }
      return { state: "not_sent", reason: begun.reason };
    }

    const recorded = writeRequired(
      "committing",
      () => actionLog.update(actionId, { state: "committing" }, "pending") === 1
    );
    if (!recorded) {
      pendingActions.finish(actionId, "failed");
      record(() => actionLog.update(actionId, { state: "cancelled", errorCode: "receipt_unavailable" }));
      return { state: "not_sent", reason: "receipt_unavailable" };
    }

    let result;
    try {
      result = await connector.commit(entry.action, entry.payload, sanitizeEdits(edits));
    } catch (error) {
      logger.warn(
        "connector commit threw",
        { connectorId: entry.connectorId, action: entry.action, error: error.message },
        "connectors"
      );
      result = { state: "unknown" };
    }

    pendingActions.finish(actionId, result.state);
    record(() =>
      actionLog.update(actionId, {
        state: result.state,
        resultUrl: result.url || result.checkUrl || null,
        errorCode: result.errorCode || null,
      })
    );
    logger.info(
      "connector action finished",
      { connectorId: entry.connectorId, action: entry.action, state: result.state },
      "connectors"
    );
    return result;
  }

  function cancel(actionId, reason) {
    const safeReason = CANCEL_REASONS.has(reason) ? reason : "cancelled_by_user";
    const cancelled = pendingActions.cancel(actionId);
    if (cancelled) {
      const state = safeReason === "expired" ? "expired" : "cancelled";
      record(() => actionLog.update(actionId, { state, errorCode: safeReason }));
    }
    return { cancelled };
  }

  async function runDirect(connectorId, action, args, policyState, runtime) {
    const refusal = policyRefusal(policyState);
    if (refusal) return { state: "unavailable", reason: refusal };
    const resolved = resolveAction(connectorId, action, "direct");
    if (resolved.error) return { state: "unavailable", reason: resolved.error };

    const id = randomId();
    const recorded = writeRequired("direct", () => {
      actionLog.insert({ id, connector: connectorId, action, kind: "direct", state: "committing" });
    });
    if (!recorded) return { state: "unavailable", reason: "receipt_unavailable" };

    let result;
    try {
      result = await resolved.connector.runDirect(action, args || {}, runtime || {});
    } catch (error) {
      logger.warn("connector direct action threw", { connectorId, action, error: error.message }, "connectors");
      result = { state: "failed", errorCode: "direct_failed", message: "That action didn't complete." };
    }
    record(() =>
      actionLog.update(id, {
        state: result.state,
        destinationLabel: result.destinationLabel || null,
        errorCode: result.errorCode || null,
      })
    );
    return result;
  }

  function invalidate(connectorId) {
    const removed = pendingActions.invalidateConnector(connectorId);
    for (const actionId of removed) {
      record(() => actionLog.update(actionId, { state: "cancelled", errorCode: "connection_changed" }));
    }
    return removed;
  }

  function recentActions(connectorId, limit) {
    const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 50) : 10;
    return actionLog.listRecent(connectorId, safeLimit);
  }

  return { status, prepare, commit, cancel, runDirect, invalidate, recentActions };
}

module.exports = { createConnectorManager };
