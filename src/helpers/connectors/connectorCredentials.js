const crypto = require("crypto");

// One login per OpenWhispr account and connector. The file name hashes the
// account id, so any id is a safe file name, and one account's login is
// never overwritten by, or read as, another's.
function slotFor(accountId, connectorId) {
  const accountKey = crypto
    .createHash("sha256")
    .update(String(accountId))
    .digest("hex")
    .slice(0, 24);
  return `${connectorId}-${accountKey}`;
}

function codedError(code) {
  return Object.assign(new Error(code), { code });
}

function createConnectorCredentials({ store, getAccountId }) {
  const generation = (accountId, connectorId) =>
    accountId ? store.getGeneration(slotFor(accountId, connectorId)) : 0;

  // The login stored for this account, with the generation it was read at.
  function read(accountId, connectorId) {
    if (!accountId) return null;
    const credential = store.read(slotFor(accountId, connectorId));
    return credential ? { credential, generation: generation(accountId, connectorId) } : null;
  }

  // Every write names the account and the generation its caller started
  // from. A reconnect, disconnect or account switch that landed in between
  // wins, and the late write is refused instead of overwriting it.
  function expect(accountId, connectorId, expectedGeneration) {
    if (!accountId) throw codedError("signed_out");
    if (generation(accountId, connectorId) !== expectedGeneration) {
      throw codedError("connection_changed");
    }
  }

  return {
    activeAccountId: () => getAccountId() || null,
    read,
    generation,
    // A new login: approvals bound to the old one must not send.
    replace(accountId, connectorId, credential, expectedGeneration) {
      expect(accountId, connectorId, expectedGeneration);
      store.replace(slotFor(accountId, connectorId), credential);
      return generation(accountId, connectorId);
    },
    // A token refresh for the same login keeps its generation, so approvals
    // bound to it stay valid.
    save(accountId, connectorId, credential, expectedGeneration) {
      expect(accountId, connectorId, expectedGeneration);
      store.save(slotFor(accountId, connectorId), credential);
    },
    clear(accountId, connectorId, expectedGeneration) {
      expect(accountId, connectorId, expectedGeneration);
      store.clear(slotFor(accountId, connectorId));
    },
  };
}

module.exports = { createConnectorCredentials, slotFor };
