function createActionLog(databaseManager) {
  return {
    insert: (row) => databaseManager.insertConnectorAction(row),
    update: (id, patch, fromState) =>
      databaseManager.updateConnectorActionState(id, patch, fromState ?? null),
    listRecent: (connector, limit, accountId) =>
      databaseManager.listRecentConnectorActions(connector, limit, accountId),
    reconcileInterrupted: () => databaseManager.reconcileInterruptedConnectorActions(),
  };
}

module.exports = { createActionLog };
