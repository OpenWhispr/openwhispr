const crypto = require("crypto");

const PENDING_TTL_MS = 10 * 60 * 1000;

// A pending action may only be sent under the connection it was prepared on:
// a reconnect (generation bump) or another account must not inherit it.
function bindingsMatch(a, b) {
  return Boolean(
    a &&
    b &&
    a.accountId === b.accountId &&
    (a.workspaceId ?? null) === (b.workspaceId ?? null) &&
    a.generation === b.generation
  );
}

function createPendingActions({
  now = Date.now,
  randomId = () => crypto.randomBytes(16).toString("hex"),
  ttlMs = PENDING_TTL_MS,
} = {}) {
  const actions = new Map();

  function isExpired(entry) {
    return now() - entry.createdAt > ttlMs;
  }

  function create({ connectorId, action, binding, accountId, payload, preview }) {
    const actionId = randomId();
    actions.set(actionId, {
      actionId,
      connectorId,
      action,
      binding,
      accountId,
      payload,
      preview,
      state: "pending",
      createdAt: now(),
    });
    return actionId;
  }

  function get(actionId) {
    const entry = actions.get(actionId);
    return entry ? { ...entry } : null;
  }

  function beginCommit(actionId, currentBinding) {
    const entry = actions.get(actionId);
    if (!entry) return { ok: false, reason: "not_found" };
    if (entry.state !== "pending") return { ok: false, reason: "not_pending" };
    if (isExpired(entry)) {
      actions.delete(actionId);
      return { ok: false, reason: "expired" };
    }
    if (!bindingsMatch(entry.binding, currentBinding)) {
      actions.delete(actionId);
      return { ok: false, reason: "connection_changed" };
    }
    entry.state = "committing";
    return { ok: true, entry: { ...entry } };
  }

  function finish(actionId) {
    const entry = actions.get(actionId);
    if (!entry || entry.state !== "committing") return false;
    actions.delete(actionId);
    return true;
  }

  // Only a pending action can be withdrawn; once committing, the send may
  // already have reached the provider and its real outcome must be recorded.
  function cancel(actionId) {
    const entry = actions.get(actionId);
    if (!entry || entry.state !== "pending") return false;
    actions.delete(actionId);
    return true;
  }

  function invalidateConnector(connectorId) {
    const removed = [];
    for (const [actionId, entry] of actions) {
      if (entry.connectorId === connectorId && entry.state === "pending") {
        actions.delete(actionId);
        removed.push(actionId);
      }
    }
    return removed;
  }

  // Committing actions are left alone: their real outcome is still coming.
  function sweepExpired() {
    const expired = [];
    for (const [actionId, entry] of actions) {
      if (entry.state === "pending" && isExpired(entry)) {
        actions.delete(actionId);
        expired.push(actionId);
      }
    }
    return expired;
  }

  return { create, get, beginCommit, finish, cancel, invalidateConnector, sweepExpired };
}

module.exports = { createPendingActions, bindingsMatch, PENDING_TTL_MS };
