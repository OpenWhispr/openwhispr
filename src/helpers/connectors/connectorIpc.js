const { connectorPolicyState } = require("./connectorPolicy");

const POLICY_TIMEOUT_MS = 1500;

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function createConnectorPolicyResolver({
  getAuthHeader,
  getPolicy,
  getAuthGeneration,
  timeoutMs = POLICY_TIMEOUT_MS,
}) {
  // The deadline and the failure handling cover the whole resolution,
  // including the auth-header lookup: nothing here can hang or throw.
  return async (event) => {
    const resolution = (async () => {
      const authHeaders = (await getAuthHeader(event)) || {};
      // No account means no org policy can apply (same rule as screen context).
      if (!authHeaders.Authorization && !authHeaders.Cookie) return "allowed";
      const snapshot = await getPolicy({ expectedAuthGeneration: getAuthGeneration(), authHeaders });
      return connectorPolicyState(snapshot);
    })().catch(() => "unavailable");

    let timer;
    const deadline = new Promise((resolve) => {
      timer = setTimeout(() => resolve("unavailable"), timeoutMs);
    });
    try {
      return await Promise.race([resolution, deadline]);
    } finally {
      clearTimeout(timer);
    }
  };
}

function registerConnectorIpc({ ipcMain, manager, getPolicyState, findContacts }) {
  ipcMain.handle("connector-status", () => manager.status());

  ipcMain.handle("connector-prepare", async (event, connectorId, action, args) => {
    if (!isNonEmptyString(connectorId) || !isNonEmptyString(action) || !isPlainObject(args)) {
      return { status: "unavailable", reason: "invalid_request" };
    }
    return manager.prepare(connectorId, action, args, await getPolicyState(event));
  });

  ipcMain.handle("connector-commit", async (event, actionId, edits) => {
    if (!isNonEmptyString(actionId)) return { state: "not_sent", reason: "invalid_request" };
    return manager.commit(actionId, isPlainObject(edits) ? edits : {}, await getPolicyState(event));
  });

  ipcMain.handle("connector-cancel", (_event, actionId, reason) => {
    if (!isNonEmptyString(actionId)) return { cancelled: false };
    return manager.cancel(actionId, reason);
  });

  ipcMain.handle("connector-run-direct", async (event, connectorId, action, args) => {
    if (!isNonEmptyString(connectorId) || !isNonEmptyString(action) || !isPlainObject(args)) {
      return { state: "unavailable", reason: "invalid_request" };
    }
    return manager.runDirect(connectorId, action, args, await getPolicyState(event), {
      webContents: event.sender,
    });
  });

  ipcMain.handle("connector-recent-actions", (_event, connectorId, limit) => {
    if (!isNonEmptyString(connectorId)) return [];
    return manager.recentActions(connectorId, limit);
  });

  if (findContacts) {
    ipcMain.handle("connector-find-contacts", (_event, query) => {
      if (typeof query !== "string" || !query.trim()) return { contacts: [] };
      return { contacts: findContacts(query.trim()) };
    });
  }
}

module.exports = { registerConnectorIpc, createConnectorPolicyResolver };
