function createActionLog(databaseManager) {
  return {
    insert: (row) => databaseManager.insertConnectorAction(row),
    update: (id, patch, fromState) =>
      databaseManager.updateConnectorActionState(id, patch, fromState ?? null),
    listRecent: (connector, limit) => databaseManager.listRecentConnectorActions(connector, limit),
    reconcileInterrupted: () => databaseManager.reconcileInterruptedConnectorActions(),
  };
}

module.exports = { createActionLog };
