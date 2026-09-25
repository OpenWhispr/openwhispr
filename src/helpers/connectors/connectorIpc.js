const { connectorPolicyState, policyRefusal } = require("./connectorPolicy");

const POLICY_TIMEOUT_MS = 1500;
// A name or part of an address; anything longer is not a lookup.
const MAX_CONTACT_QUERY_LENGTH = 200;

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function createConnectorPolicyResolver({
  getAuthHeader,
  getPolicy,
  peekPolicy,
  getAuthGeneration,
  timeoutMs = POLICY_TIMEOUT_MS,
}) {
  // The deadline and the failure handling cover the whole resolution,
  // including the auth-header lookup: nothing here can hang or throw.
  return async (event) => {
    let request = null;
    const resolution = (async () => {
      // Read before the (possibly async cookie) header lookup: a sign-in
      // during it must fail the generation check, not pair old headers with
      // the new generation.
      const expectedAuthGeneration = getAuthGeneration();
      const authHeaders = (await getAuthHeader(event)) || {};
      // No account means no org policy can apply (same rule as screen context).
      if (!authHeaders.Authorization && !authHeaders.Cookie) return "allowed";
      request = { expectedAuthGeneration, authHeaders };
      const snapshot = await getPolicy(request);
      return connectorPolicyState(snapshot);
    })().catch(() => "unavailable");

    let timer;
    const deadline = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    });
    try {
      const state = await Promise.race([resolution, deadline]);
      if (state !== null) return state;
      // A refresh that outlives the deadline must not override the verdict
      // already held for this account; with none held, fail closed.
      try {
        return request && peekPolicy ? connectorPolicyState(peekPolicy(request)) : "unavailable";
      } catch {
        return "unavailable";
      }
    } finally {
      clearTimeout(timer);
    }
  };
}

function sameAccountScope(left, right) {
  return Boolean(
    left &&
    right &&
    left.accountId === right.accountId &&
    left.authGeneration === right.authGeneration
  );
}

// getAccountScope() is the signed-in account bound to the current credential
// and its generation, or null.
function registerConnectorIpc({ ipcMain, manager, getPolicyState, getAccountScope, findContacts }) {
  // The verdict and the account that owns the receipt come from one
  // credential: a sign-in or account switch during the policy wait leaves no
  // account, so the action is refused rather than filed under the wrong one.
  async function resolveCallAuth(event) {
    const scope = getAccountScope();
    const policyState = await getPolicyState(event);
    return {
      policyState,
      accountId: sameAccountScope(scope, getAccountScope()) ? scope.accountId : null,
    };
  }

  // Direct runs by the renderer's run id until they finish. A cancel (Esc)
  // aborts the run's signal: a run still waiting on policy stops there, and
  // the connector checks the signal again right before it acts.
  const activeRuns = new Map();

  ipcMain.handle("connector-status", () => manager.status());

  ipcMain.handle("connector-prepare", async (event, connectorId, action, args) => {
    if (!isNonEmptyString(connectorId) || !isNonEmptyString(action) || !isPlainObject(args)) {
      return { status: "unavailable", reason: "invalid_request" };
    }
    return manager.prepare(connectorId, action, args, await resolveCallAuth(event));
  });

  ipcMain.handle("connector-commit", async (event, actionId, edits) => {
    if (!isNonEmptyString(actionId)) return { state: "not_sent", reason: "invalid_request" };
    return manager.commit(
      actionId,
      isPlainObject(edits) ? edits : {},
      await resolveCallAuth(event)
    );
  });

  // A run id equal to a pending approval's id must not swallow that
  // approval's cancel, so both are cancelled.
  ipcMain.handle("connector-cancel", (_event, actionId, reason) => {
    if (!isNonEmptyString(actionId)) return { cancelled: false };
    const run = activeRuns.get(actionId);
    run?.abort();
    const { cancelled } = manager.cancel(actionId, reason);
    return { cancelled: Boolean(run) || cancelled };
  });

  ipcMain.handle("connector-run-direct", async (event, connectorId, action, args, runId) => {
    if (!isNonEmptyString(connectorId) || !isNonEmptyString(action) || !isPlainObject(args)) {
      return { state: "unavailable", reason: "invalid_request" };
    }
    const tracked = isNonEmptyString(runId);
    // A second run under a live id would make the first one uncancellable.
    if (tracked && activeRuns.has(runId)) {
      return { state: "unavailable", reason: "invalid_request" };
    }
    const controller = new AbortController();
    if (tracked) activeRuns.set(runId, controller);
    try {
      const auth = await resolveCallAuth(event);
      if (controller.signal.aborted) return { state: "not_sent", reason: "cancelled" };
      return await manager.runDirect(connectorId, action, args, auth, {
        webContents: event.sender,
        signal: controller.signal,
      });
    } finally {
      if (tracked) activeRuns.delete(runId);
    }
  });

  ipcMain.handle("connector-recent-actions", (_event, connectorId, limit) => {
    if (!isNonEmptyString(connectorId)) return [];
    return manager.recentActions(connectorId, limit, getAccountScope()?.accountId ?? null);
  });

  if (findContacts) {
    // The results go to the model (and its provider), so the org switch
    // applies here too, not just to actions that leave the device.
    ipcMain.handle("connector-find-contacts", async (event, query) => {
      if (typeof query !== "string" || !query.trim() || query.length > MAX_CONTACT_QUERY_LENGTH) {
        return { contacts: [] };
      }
      const refusal = policyRefusal(await getPolicyState(event));
      if (refusal) return { contacts: [], unavailableReason: refusal };
      return findContacts(query.trim());
    });
  }
}

module.exports = { registerConnectorIpc, createConnectorPolicyResolver };
