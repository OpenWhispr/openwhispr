function createSalesforceNoteReader({ database, getAccountId }) {
  return function getSalesforceNote(noteId, ownerAccountId) {
    // The connector login and local note database must still belong to the
    // account that began the action, including across awaits in the connector.
    if (
      !ownerAccountId ||
      ownerAccountId !== getAccountId() ||
      ownerAccountId !== database.activeAccountId ||
      !Number.isSafeInteger(noteId) ||
      noteId <= 0
    )
      return null;
    const note = database.getNote(noteId);
    return note && !note.deleted_at ? note : null;
  };
}

module.exports = { createSalesforceNoteReader };
