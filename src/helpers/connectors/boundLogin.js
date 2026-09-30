const { describeError } = require("./errorSummary");

const CONNECTION_CHANGED = { ok: false, errorCode: "connection_changed" };

function isRace(error) {
  return error.code === "connection_changed" || error.code === "signed_out";
}

/**
 * The token handling every OAuth connector (Slack, Gmail) shares: an action
 * only ever reads, refreshes or flags the one login it was approved under.
 * A reconnect, disconnect or account switch that lands first always wins,
 * and nothing is written for the old login.
 *
 * `sameLogin(entry, binding)` says whether a stored login is the bound one,
 * `isFresh(credential)` whether its access token can still be used, and
 * `refresh(binding, credential)` gets a new one (calling saveRefreshed).
 */
function createBoundLogin({ connectorId, credentials, sameLogin, isFresh, refresh, logger }) {
  const refreshes = new Map();

  const read = (binding) => credentials.read(binding?.ownerAccountId ?? null, connectorId);

  function stillBound(binding) {
    return sameLogin(read(binding), binding);
  }

  // The bound login's stored credential, read locally with no refresh, or
  // null when a reconnect, disconnect or account switch replaced it.
  function boundCredential(binding) {
    const entry = read(binding);
    return sameLogin(entry, binding) ? entry.credential : null;
  }

  // The provider said this login is gone; only the bound login is flagged.
  function markReconnect(binding) {
    const entry = read(binding);
    if (!sameLogin(entry, binding)) return CONNECTION_CHANGED;
    try {
      credentials.save(
        binding.ownerAccountId,
        connectorId,
        { ...entry.credential, needsReconnect: true },
        binding.generation
      );
    } catch (error) {
      if (isRace(error)) return CONNECTION_CHANGED;
      // A real write failure (disk, permission, encryption). The provider's
      // answer still stands: the login is gone, though the flag wasn't saved.
      logger?.warn(`${connectorId} reconnect flag save failed`, describeError(error), "connectors");
    }
    return { ok: false, errorCode: "reconnect_needed" };
  }

  // Saved before use, and only into the slot and generation the refresh
  // started from.
  function saveRefreshed(binding, next) {
    try {
      credentials.save(binding.ownerAccountId, connectorId, next, binding.generation);
    } catch (error) {
      if (isRace(error)) return CONNECTION_CHANGED;
      // The new token is lost, so this is worth a log line, never the token.
      logger?.warn(`${connectorId} token save failed`, describeError(error), "connectors");
      return { ok: false, errorCode: "credential_save_failed" };
    }
    return { ok: true, token: next.accessToken, credential: next };
  }

  async function getAccessToken(binding, { forceRefresh = false } = {}) {
    const entry = read(binding);
    if (!sameLogin(entry, binding)) return CONNECTION_CHANGED;
    const { credential } = entry;
    if (credential.needsReconnect) return { ok: false, errorCode: "reconnect_needed" };
    if (isFresh(credential) && !forceRefresh) {
      return { ok: true, token: credential.accessToken, credential };
    }
    // Concurrent callers for one login share one refresh (Slack's refresh
    // tokens are single-use).
    const key = `${binding.ownerAccountId}:${binding.generation}`;
    let pending = refreshes.get(key);
    if (!pending) {
      pending = refresh(binding, credential).finally(() => refreshes.delete(key));
      refreshes.set(key, pending);
    }
    return pending;
  }

  return { stillBound, boundCredential, markReconnect, saveRefreshed, getAccessToken };
}

module.exports = { createBoundLogin };
