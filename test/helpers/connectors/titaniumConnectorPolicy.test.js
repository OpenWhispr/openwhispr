const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const {
  titaniumConnectorPolicyState,
  titaniumAccountScope,
  titaniumAccountChanged,
  createTitaniumConnectorBindings,
  watchTitaniumAccount,
} = require("../../../src/helpers/connectors/titaniumConnectorPolicy");

test("every signed-in/bound/licensed combination maps to one verdict", () => {
  const state = (signedIn, accountBound, licensed) => ({ signedIn, accountBound, licensed });
  assert.equal(titaniumConnectorPolicyState(null), "signed_out");
  assert.equal(titaniumConnectorPolicyState(undefined), "signed_out");
  assert.equal(titaniumConnectorPolicyState(state(false, true, true)), "signed_out");
  assert.equal(titaniumConnectorPolicyState(state(true, false, true)), "reauth_required");
  assert.equal(titaniumConnectorPolicyState(state(true, false, false)), "reauth_required");
  assert.equal(titaniumConnectorPolicyState(state(true, true, false)), "plan_required");
  assert.equal(titaniumConnectorPolicyState(state(true, true, true)), "allowed");
  // Only a literal true counts: a truthy string never allows.
  assert.equal(titaniumConnectorPolicyState(state(true, true, "yes")), "plan_required");
});

test("account scope is null-safe", () => {
  assert.equal(titaniumAccountScope(null), null);
  assert.equal(titaniumAccountScope({}), null);
  const scope = { accountId: "acc_1", authGeneration: 2 };
  assert.deepEqual(titaniumAccountScope({ getAccountScope: () => scope }), scope);
});

test("only a sign-in, sign-out or another account is an account change", () => {
  const out = { signedIn: false, accountId: null };
  const a = { signedIn: true, accountId: "acc_a" };
  const b = { signedIn: true, accountId: "acc_b" };
  const unbound = { signedIn: true, accountId: null };
  assert.equal(titaniumAccountChanged(a, { ...a }), false);
  assert.equal(titaniumAccountChanged(a, out), true);
  assert.equal(titaniumAccountChanged(out, a), true);
  assert.equal(titaniumAccountChanged(a, b), true);
  assert.equal(titaniumAccountChanged(unbound, a), true);
  assert.equal(titaniumAccountChanged(out, out), false);
  assert.equal(titaniumAccountChanged(undefined, out), false);
});

function fakeTitaniumSession(initial) {
  const session = new EventEmitter();
  session.current = initial;
  session.getState = () => ({
    signedIn: session.current.signedIn,
    accountBound: Boolean(session.current.accountId),
    licensed: session.current.licensed,
  });
  session.getAccountScope = () =>
    session.current.accountId
      ? { accountId: session.current.accountId, authGeneration: session.current.generation ?? 1 }
      : null;
  session.set = (next) => {
    session.current = { ...session.current, ...next };
    session.emit("changed", session.getState());
  };
  return session;
}

test("bindings read the live session and treat a missing session as signed out", () => {
  let session = null;
  const bindings = createTitaniumConnectorBindings(() => session);
  assert.equal(bindings.getPolicyState(), "signed_out");
  assert.equal(bindings.getAccountScope(), null);
  session = fakeTitaniumSession({ signedIn: true, accountId: "acc_1", licensed: true });
  assert.equal(bindings.getPolicyState(), "allowed");
  assert.deepEqual(bindings.getAccountScope(), { accountId: "acc_1", authGeneration: 1 });
});

test("watchTitaniumAccount fires once per account change and never for a same-account change", () => {
  const session = fakeTitaniumSession({ signedIn: true, accountId: "acc_a", licensed: true });
  let changes = 0;
  const stop = watchTitaniumAccount(session, () => (changes += 1));

  session.set({ licensed: false }); // license only
  session.set({ generation: 5 }); // generation only
  assert.equal(changes, 0);

  session.set({ accountId: "acc_b" }); // switch
  assert.equal(changes, 1);
  session.set({ signedIn: false, accountId: null }); // sign-out
  assert.equal(changes, 2);
  session.set({ signedIn: true, accountId: "acc_b" }); // sign back in
  assert.equal(changes, 3);

  stop();
  session.set({ accountId: "acc_c" });
  assert.equal(changes, 3);
});
