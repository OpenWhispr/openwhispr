const crypto = require("crypto");
const { policyRefusal } = require("./connectorPolicy");

const CANCEL_REASONS = new Set(["cancelled_by_user", "conversation_ended", "expired"]);

// A connector is third-party code (or a stub in tests), so none of its result
// fields are trusted: each state keeps only the fields it defines, with their
// types checked. Anything else could leak to the renderer, or make the receipt
// write throw and leave the row stuck at "committing".
function stringFields(fields) {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => typeof value === "string")
  );
}

function booleanFields(fields) {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => typeof value === "boolean")
  );
}

function stringOr(value, fallback) {
  return typeof value === "string" ? value : fallback;
}

const FAILED_MESSAGE = "That action didn't go through.";

function failedResult(result) {
  return {
    state: "failed",
    errorCode: stringOr(result.errorCode, "action_failed"),
    message: stringOr(result.message, FAILED_MESSAGE),
  };
}

// Anything other than a recognized outcome may still have reached the
// provider, so it is "unknown", never "failed".
function normalizeCommitResult(result) {
  switch (result?.state) {
    case "sent":
      return { state: "sent", ...stringFields({ url: result.url }) };
    case "failed":
      return failedResult(result);
    case "unknown":
      return { state: "unknown", ...stringFields({ checkUrl: result.checkUrl }) };
    default:
      return { state: "unknown" };
  }
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

// "not_sent" is the connector saying it stopped before acting (a cancel that
// landed in time).
function normalizeDirectResult(result) {
  const destination = stringFields({ destinationLabel: result?.destinationLabel });
  switch (result?.state) {
    case "sent":
      return {
        state: "sent",
        destinationLabel: "",
        ...destination,
        ...booleanFields({
          bodyCopied: result.bodyCopied,
          subjectCopied: result.subjectCopied,
          copyFailed: result.copyFailed,
        }),
      };
    case "failed":
      return { ...failedResult(result), ...destination };
    case "not_sent":
      return { state: "not_sent", reason: stringOr(result.reason, "cancelled") };
    default:
      return uncertainDirectResult("invalid_result");
  }
}

const INVALID_PREPARE_RESULT = {
  status: "failed",
  errorCode: "invalid_result",
  message: "Couldn't prepare that action.",
};

const RECEIPT_UNAVAILABLE_PREPARE_RESULT = {
  status: "failed",
  errorCode: "receipt_unavailable",
  message: "Couldn't record this action, so nothing was prepared.",
};

function normalizePreviewNote(note) {
  if (!note || typeof note.key !== "string") return null;
  return note.values && typeof note.values === "object"
    ? { key: note.key, values: stringFields(note.values) }
    : { key: note.key };
}

// The card renders exactly this, so a preview missing a field it needs is
// malformed rather than shown half empty.
function normalizePreview(preview) {
  if (!preview || typeof preview !== "object") return null;
  const { verbKey, destinationLabel, accountLabel, body } = preview;
  if (
    ![verbKey, destinationLabel, accountLabel, body].every((value) => typeof value === "string")
  ) {
    return null;
  }
  return {
    verbKey,
    destinationLabel,
    accountLabel,
    body,
    ...stringFields({ workspaceLabel: preview.workspaceLabel, title: preview.title }),
    ...(Array.isArray(preview.notes)
      ? { notes: preview.notes.map(normalizePreviewNote).filter(Boolean) }
      : {}),
  };
}

// The payload stays in main; only the fields each status defines reach the
// renderer.
function normalizePrepareResult(result) {
  switch (result?.status) {
    case "ready": {
      const preview = normalizePreview(result.preview);
      return preview
        ? { status: "ready", payload: result.payload, preview }
        : INVALID_PREPARE_RESULT;
    }
    case "needs_clarification":
      return {
        status: "needs_clarification",
        message: stringOr(result.message, ""),
        candidates: Array.isArray(result.candidates)
          ? result.candidates.filter((candidate) => typeof candidate === "string")
          : [],
      };
    case "failed":
      return {
        status: "failed",
        errorCode: stringOr(result.errorCode, "prepare_failed"),
        message: stringOr(result.message, INVALID_PREPARE_RESULT.message),
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

// Every action call carries `auth`: the org policy verdict and the signed-in
// account it was resolved for. The account owns the receipt, so an action
// with none (signed out, or mid sign-in or account switch) is refused before
// anything is written or done.
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
    if (reconciled.unknown || reconciled.cancelled || reconciled.orphaned) {
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

  async function prepare(connectorId, action, args, { policyState, accountId }) {
    expireStale();
    const refusal = policyRefusal(policyState);
    if (refusal) return { status: "unavailable", reason: refusal };
    const resolved = resolveAction(connectorId, action, "approval");
    if (resolved.error) return { status: "unavailable", reason: resolved.error };
    if (!accountId) return RECEIPT_UNAVAILABLE_PREPARE_RESULT;
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
      accountId,
      payload: prepared.payload,
      preview: prepared.preview,
    });
    const recorded = writeRequired("pending", () => {
      actionLog.insert({
        id: actionId,
        accountId,
        connector: connectorId,
        action,
        kind: "approval",
        destinationLabel: prepared.preview.destinationLabel,
        state: "pending",
      });
    });
    if (!recorded) {
      pendingActions.cancel(actionId);
      return RECEIPT_UNAVAILABLE_PREPARE_RESULT;
    }
    return { status: "ready", actionId, preview: prepared.preview };
  }

  // Withdrawn rather than left pending: a refused card is settled in the
  // renderer, so nothing may commit it later.
  function withdrawPending(actionId, reason) {
    pendingActions.cancel(actionId);
    record(() => actionLog.update(actionId, { state: "cancelled", errorCode: reason }, "pending"));
    return { state: "not_sent", reason };
  }

  async function commit(actionId, edits, { policyState, accountId }) {
    expireStale();
    const entry = pendingActions.get(actionId);
    if (!entry) return { state: "not_sent", reason: "not_found" };
    // A second click while the first is sending must neither send nor
    // overwrite the in-flight row.
    if (entry.state !== "pending") return { state: "not_sent", reason: "not_pending" };

    const refusal = policyRefusal(policyState);
    if (refusal) return withdrawPending(actionId, refusal);
    // Another account (or none) must not send what this one prepared.
    if (entry.accountId !== accountId) return withdrawPending(actionId, "account_changed");

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
      result = normalizeCommitResult(
        await connector.commit(entry.action, entry.payload, sanitizeEdits(edits))
      );
    } catch (error) {
      logger.warn(
        "connector commit threw",
        { connectorId: entry.connectorId, action: entry.action, error: error.message },
        "connectors"
      );
      result = { state: "unknown" };
    }

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

  // runtime may carry a `signal`: a cancel that lands before the side effect
  // must stop it (the connector checks it right before acting).
  async function runDirect(connectorId, action, args, { policyState, accountId }, runtime) {
    const refusal = policyRefusal(policyState);
    if (refusal) return { state: "unavailable", reason: refusal };
    const resolved = resolveAction(connectorId, action, "direct");
    if (resolved.error) return { state: "unavailable", reason: resolved.error };
    if (!accountId) return { state: "unavailable", reason: "receipt_unavailable" };

    const id = randomId();
    const recorded = writeRequired("direct", () => {
      actionLog.insert({
        id,
        accountId,
        connector: connectorId,
        action,
        kind: "direct",
        state: "committing",
      });
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
    const outcome =
      result.state === "not_sent"
        ? { state: "cancelled", errorCode: result.reason }
        : { state: result.state, errorCode: result.errorCode || null };
    record(() =>
      actionLog.update(id, { ...outcome, destinationLabel: result.destinationLabel || null })
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

  // Receipts name the people a user wrote to: only the account that took the
  // action sees them.
  function recentActions(connectorId, limit, accountId) {
    expireStale();
    const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 50) : 10;
    return actionLog.listRecent(connectorId, safeLimit, accountId);
  }

  return { status, prepare, commit, cancel, runDirect, invalidate, recentActions };
}

module.exports = { createConnectorManager };
