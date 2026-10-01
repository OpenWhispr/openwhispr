const { connectorPolicyState, policyRefusal } = require("./connectorPolicy");

const POLICY_TIMEOUT_MS = 1500;
// A name or part of an address; anything longer is not a lookup.
const MAX_CONTACT_QUERY_LENGTH = 200;
// More than any meeting invite; a longer list is cut, not refused.
const MAX_NOTE_ATTENDEES = 200;
// RFC 5321's address limit, and a generous display name.
const MAX_ATTENDEE_EMAIL_LENGTH = 320;
const MAX_ATTENDEE_NAME_LENGTH = 200;
// Calendar event ids are well under this (Graph's are the longest, ~150).
const MAX_EVENT_ID_LENGTH = 1024;

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Only the fields the attendee filter reads, from well-formed items.
function sanitizeNoteAttendees(list) {
  const attendees = [];
  for (const item of list.slice(0, MAX_NOTE_ATTENDEES)) {
    if (!isPlainObject(item) || !isNonEmptyString(item.email)) continue;
    if (item.email.length > MAX_ATTENDEE_EMAIL_LENGTH) continue;
    const displayName =
      typeof item.displayName === "string" && item.displayName.length <= MAX_ATTENDEE_NAME_LENGTH
        ? item.displayName
        : null;
    attendees.push({
      email: item.email,
      displayName,
      self: item.self === true,
      resource: item.resource === true,
    });
  }
  return attendees;
}

// Connectors must tell "signed out" ({}) from "can't tell" (null). Without a
// bearer token only the sender's window can read the cookie session, so a
// window that is already gone must not read as signed out.
function createConnectorAuthLookup({ hasBearerToken, windowFor, authHeaderFor }) {
  return async (event) => {
    if (hasBearerToken()) return authHeaderFor(null);
    const win = windowFor(event);
    if (!win || win.isDestroyed()) return null;
    return authHeaderFor(win);
  };
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
      // Read before the lookup: a sign-in or sign-out during it then fails
      // the policy fetch's generation check instead of passing it.
      const expectedAuthGeneration = getAuthGeneration();
      const authHeaders = await getAuthHeader(event);
      if (!authHeaders || typeof authHeaders !== "object") return "unavailable";
      // Connector logins outlive an OpenWhispr sign-out, so no account means
      // no action (unlike screen context, where signed out is allowed).
      if (!authHeaders.Authorization && !authHeaders.Cookie) return "signed_out";
      // Assigned before the fetch: the deadline's fallback peeks this request.
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

// Connect, disconnect and the connectors' bindings file logins under the
// account receipts are filed under: the one getAccountScope() binds to the
// credential in use, or none.
function connectorAccountIdFrom(getAccountScope) {
  return () => getAccountScope()?.accountId ?? null;
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
function registerConnectorIpc({
  ipcMain,
  manager,
  getPolicyState,
  getAccountScope,
  findContacts,
  noteAttendees,
}) {
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

  // Reads for the model: the same checks as prepare, and nothing is written.
  ipcMain.handle("connector-query", async (event, connectorId, action, args) => {
    if (!isNonEmptyString(connectorId) || !isNonEmptyString(action) || !isPlainObject(args)) {
      return { status: "unavailable", reason: "invalid_request" };
    }
    return manager.query(connectorId, action, args, await resolveCallAuth(event));
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

  // Connects still waiting on policy, before the manager holds them. A cancel
  // that lands then must stop them there: nothing else would end a device
  // flow that then polls for 15 minutes with nothing on screen.
  const pendingConnects = new Set();

  ipcMain.handle("connector-connect", async (event, connectorId) => {
    if (!isNonEmptyString(connectorId)) return { status: "unavailable", reason: "invalid_request" };
    const pending = { connectorId, controller: new AbortController() };
    pendingConnects.add(pending);
    let policyState;
    try {
      policyState = await getPolicyState(event);
    } finally {
      pendingConnects.delete(pending);
    }
    // What an aborted flow reports, so the row stays silent.
    if (pending.controller.signal.aborted) {
      return { status: "failed", errorCode: "oauth_cancelled" };
    }
    return manager.connect(connectorId, policyState);
  });

  // Stopping a connect is always allowed, so it skips the policy check too.
  ipcMain.handle("connector-cancel-connect", (_event, connectorId) => {
    if (!isNonEmptyString(connectorId)) return { status: "unavailable", reason: "invalid_request" };
    let stoppedPending = false;
    for (const pending of pendingConnects) {
      if (pending.connectorId !== connectorId) continue;
      pending.controller.abort();
      stoppedPending = true;
    }
    const result = manager.cancelConnect(connectorId);
    return stoppedPending ? { status: "cancelled" } : result;
  });

  // Removing access is always allowed, so disconnect skips the policy check.
  ipcMain.handle("connector-disconnect", (_event, connectorId) => {
    if (!isNonEmptyString(connectorId)) return { status: "unavailable", reason: "invalid_request" };
    return manager.disconnect(connectorId);
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

  if (noteAttendees) {
    // A note's attendees, minus the user and rooms, for the note chat's
    // context. They go to the model, so the org switch applies here too.
    ipcMain.handle("connector-note-attendees", async (event, request) => {
      if (!isPlainObject(request)) return { attendees: [] };
      const participants = Array.isArray(request.participants)
        ? sanitizeNoteAttendees(request.participants)
        : [];
      const noteId =
        Number.isSafeInteger(request.noteId) && request.noteId > 0 ? request.noteId : null;
      const calendarEventId =
        isNonEmptyString(request.calendarEventId) &&
        request.calendarEventId.length <= MAX_EVENT_ID_LENGTH
          ? request.calendarEventId
          : null;
      if (participants.length === 0 && !calendarEventId && !noteId) return { attendees: [] };
      const refusal = policyRefusal(await getPolicyState(event));
      if (refusal) return { attendees: [], unavailableReason: refusal };
      const selfEmail =
        isNonEmptyString(request.selfEmail) && request.selfEmail.length <= MAX_ATTENDEE_EMAIL_LENGTH
          ? request.selfEmail.trim()
          : null;
      return {
        attendees: await noteAttendees({ noteId, participants, calendarEventId, selfEmail }),
      };
    });
  }
}

module.exports = {
  registerConnectorIpc,
  createConnectorPolicyResolver,
  createConnectorAuthLookup,
  connectorAccountIdFrom,
};
