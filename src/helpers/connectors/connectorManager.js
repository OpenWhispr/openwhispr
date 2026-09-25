const crypto = require("crypto");
const { policyRefusal } = require("./connectorPolicy");

const CANCEL_REASONS = new Set(["cancelled_by_user", "conversation_ended", "expired"]);
const COMMIT_RESULT_STATES = new Set(["sent", "failed", "unknown"]);
const DIRECT_RESULT_STATES = new Set(["sent", "failed"]);

// A connector is third-party code (or a stub in tests); never trust its
// result shape before it gets written to the receipt or handed back. An
// undefined result would otherwise throw reading `.state`, orphaning the
// pending entry in "committing" forever.
function normalizeCommitResult(result) {
  if (result && typeof result === "object" && COMMIT_RESULT_STATES.has(result.state)) return result;
  return { state: "unknown" };
}

// A direct action that threw or answered malformed may already have acted
// (a compose window opened before a later step failed); calling it "failed"
// would invite a duplicate retry.
function uncertainDirectResult(errorCode) {
  return {
    state: "unknown",
    errorCode,
    message: "That action may have gone through. Ask the user to check before trying again.",
  };
}

function normalizeDirectResult(result) {
  if (result && typeof result === "object" && DIRECT_RESULT_STATES.has(result.state)) return result;
  return uncertainDirectResult("invalid_result");
}

const INVALID_PREPARE_RESULT = {
  status: "failed",
  errorCode: "invalid_result",
  message: "Couldn't prepare that action.",
};

// Only the fields each status defines reach the renderer, so a connector
// can't leak anything else (such as message text) through an odd result.
function normalizePrepareResult(result) {
  switch (result?.status) {
    case "ready":
      return result.preview && typeof result.preview === "object"
        ? { status: "ready", payload: result.payload, preview: result.preview }
        : INVALID_PREPARE_RESULT;
    case "needs_clarification":
      return {
        status: "needs_clarification",
        message: typeof result.message === "string" ? result.message : "",
        candidates: Array.isArray(result.candidates)
          ? result.candidates.filter((candidate) => typeof candidate === "string")
          : [],
      };
    case "failed":
      return {
        status: "failed",
        errorCode: typeof result.errorCode === "string" ? result.errorCode : "prepare_failed",
        message:
          typeof result.message === "string" ? result.message : INVALID_PREPARE_RESULT.message,
      };
    default:
      return INVALID_PREPARE_RESULT;
  }
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
      logger.error("connector receipt write failed", { step, error: error.message }, "connectors");
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

  // Expired actions leave memory (and their payloads with them) on the next
  // call, and their receipts say so rather than a later "app_quit".
  function expireStale() {
    for (const actionId of pendingActions.sweepExpired()) {
      record(() =>
        actionLog.update(actionId, { state: "expired", errorCode: "expired" }, "pending")
      );
    }
  }

  // A lookup that throws counts as no connection, so the connector's
  // exception text never reaches the renderer.
  async function readBinding(connector) {
    try {
      return await connector.getBinding();
    } catch (error) {
      logger.warn(
        "connector binding lookup failed",
        { connectorId: connector.id, error: error.message },
        "connectors"
      );
      return null;
    }
  }

  function resolveAction(connectorId, action, kind) {
    const connector = byId.get(connectorId);
    if (!connector) return { error: "unknown_connector" };
    if (connector.actions[action]?.kind !== kind) return { error: "unknown_action" };
    return { connector };
  }

  async function status() {
    return Promise.all(
      [...byId.values()].map(async (connector) => {
        try {
          return { id: connector.id, ...(await connector.getStatus()) };
        } catch (error) {
          logger.warn(
            "connector status failed",
            { connectorId: connector.id, error: error.message },
            "connectors"
          );
          return { id: connector.id, connected: false, accountLabel: null };
        }
      })
    );
  }

  async function prepare(connectorId, action, args, policyState) {
    expireStale();
    const refusal = policyRefusal(policyState);
    if (refusal) return { status: "unavailable", reason: refusal };
    const resolved = resolveAction(connectorId, action, "approval");
    if (resolved.error) return { status: "unavailable", reason: resolved.error };
    const { connector } = resolved;

    const binding = await readBinding(connector);
    if (!binding) return { status: "unavailable", reason: "not_connected" };

    let prepared;
    try {
      prepared = normalizePrepareResult(await connector.prepare(action, args || {}));
    } catch (error) {
      logger.warn(
        "connector prepare threw",
        { connectorId, action, error: error.message },
        "connectors"
      );
      return { ...INVALID_PREPARE_RESULT, errorCode: "prepare_failed" };
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
    expireStale();
    const entry = pendingActions.get(actionId);
    if (!entry) return { state: "not_sent", reason: "not_found" };
    // A second click while the first is sending must neither send nor
    // overwrite the in-flight row.
    if (entry.state !== "pending") return { state: "not_sent", reason: "not_pending" };

    const refusal = policyRefusal(policyState);
    if (refusal) {
      pendingActions.cancel(actionId);
      record(() =>
        actionLog.update(actionId, { state: "cancelled", errorCode: refusal }, "pending")
      );
      return { state: "not_sent", reason: refusal };
    }

    const connector = byId.get(entry.connectorId);
    const begun = pendingActions.beginCommit(actionId, await readBinding(connector));
    if (!begun.ok) {
      if (begun.reason === "expired" || begun.reason === "connection_changed") {
        const state = begun.reason === "expired" ? "expired" : "cancelled";
        record(() => actionLog.update(actionId, { state, errorCode: begun.reason }, "pending"));
      }
      return { state: "not_sent", reason: begun.reason };
    }

    const recorded = writeRequired(
      "committing",
      () => actionLog.update(actionId, { state: "committing" }, "pending") === 1
    );
    if (!recorded) {
      pendingActions.finish(actionId);
      record(() =>
        actionLog.update(
          actionId,
          { state: "cancelled", errorCode: "receipt_unavailable" },
          "pending"
        )
      );
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
    result = normalizeCommitResult(result);

    pendingActions.finish(actionId);
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
    expireStale();
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
      result = normalizeDirectResult(
        await resolved.connector.runDirect(action, args || {}, runtime || {})
      );
    } catch (error) {
      logger.warn(
        "connector direct action threw",
        { connectorId, action, error: error.message },
        "connectors"
      );
      result = uncertainDirectResult("direct_failed");
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
      record(() =>
        actionLog.update(actionId, { state: "cancelled", errorCode: "connection_changed" })
      );
    }
    return removed;
  }

  function recentActions(connectorId, limit) {
    expireStale();
    const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 50) : 10;
    return actionLog.listRecent(connectorId, safeLimit);
  }

  return { status, prepare, commit, cancel, runDirect, invalidate, recentActions };
}

module.exports = { createConnectorManager };
