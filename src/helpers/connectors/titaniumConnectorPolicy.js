// Connector policy for a fork build, where there is no OpenWhispr cloud session and
// no org-policy endpoint. The Titanium session is the only identity: its stable
// account id keys connector logins, and its offline-verified license is the "paid
// plan". Pure and Electron-free; main and ipcHandlers adapt a TitaniumSession to it.

/**
 * Policy verdict for a connector call.
 * signed_out: no Titanium session. reauth_required: signed in from a session that
 * holds no account id (saved before Phase 7, or the portal omitted it): sign in again,
 * never an email-keyed login. plan_required: bound but no valid license. allowed otherwise.
 */
function titaniumConnectorPolicyState(state) {
  if (!state || state.signedIn !== true) return "signed_out";
  if (state.accountBound !== true) return "reauth_required";
  if (state.licensed !== true) return "plan_required";
  return "allowed";
}

/** The {accountId, authGeneration} scope of a Titanium session, or null. */
function titaniumAccountScope(session) {
  return session?.getAccountScope?.() ?? null;
}

/**
 * True when the connector account behind two snapshots differs: sign-in or
 * sign-out, or another Titanium account. A generation bump or a license change on
 * the same account is not a change. A snapshot is {signedIn, accountId}.
 */
function titaniumAccountChanged(prev, next) {
  const before = Boolean(prev?.signedIn);
  const after = Boolean(next?.signedIn);
  if (before !== after) return true;
  return (prev?.accountId ?? null) !== (next?.accountId ?? null);
}

function snapshotOf(session) {
  return {
    signedIn: Boolean(session?.getState?.().signedIn),
    accountId: titaniumAccountScope(session)?.accountId ?? null,
  };
}

/**
 * The two inputs registerConnectorIpc needs in a fork build, read from the live
 * Titanium session (null before it exists reads as signed out).
 */
function createTitaniumConnectorBindings(getSession) {
  return {
    getPolicyState: () => titaniumConnectorPolicyState(getSession()?.getState?.()),
    getAccountScope: () => titaniumAccountScope(getSession()),
  };
}

/**
 * Calls onChanged() once per Titanium account change (sign-out, sign-in, account
 * switch), never for a same-account state change. Returns an unsubscribe function.
 */
function watchTitaniumAccount(session, onChanged) {
  if (!session?.on) return () => {};
  let last = snapshotOf(session);
  const listener = () => {
    const next = snapshotOf(session);
    const changed = titaniumAccountChanged(last, next);
    last = next;
    if (changed) onChanged();
  };
  session.on("changed", listener);
  return () => session.off?.("changed", listener);
}

module.exports = {
  titaniumConnectorPolicyState,
  titaniumAccountScope,
  titaniumAccountChanged,
  createTitaniumConnectorBindings,
  watchTitaniumAccount,
};
