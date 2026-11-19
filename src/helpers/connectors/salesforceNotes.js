function createSalesforceNoteReader({ database, getAccountId }) {
  return function getSalesforceNote(noteId, ownerAccountId) {
    // The connector login and local note database must still belong to the
    // account that began the action, including across awaits in the connector.
    if (
      !ownerAccountId ||
      ownerAccountId !== getAccountId() ||
      ownerAccountId !== database.activeAccountId
    )
      return null;
    return database.getNote(noteId);
  };
}

module.exports = { createSalesforceNoteReader };
