const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/services/bulkInvitationActions.ts");
const { CloudApiError } = require("../../src/services/cloudApi.ts");

// Records every request in order; an answer per id (an Error to reject, or { email_sent }) defaults
// to a sent invitation. Requests overlap if the code under test does not wait for the last one.
function makeDeps(answers = {}) {
  const calls = [];
  let inFlight = 0;
  let overlapped = false;
  const answer = async (kind, workspaceId, id) => {
    calls.push([kind, workspaceId, id]);
    inFlight += 1;
    if (inFlight > 1) overlapped = true;
    await new Promise((resolve) => setTimeout(resolve, 1));
    inFlight -= 1;
    const outcome = answers[id];
    if (outcome instanceof Error) throw outcome;
    return outcome ?? { email_sent: true };
  };
  return {
    calls,
    deps: {
      resend: (workspaceId, id) => answer("resend", workspaceId, id),
      revoke: async (workspaceId, id) => {
        await answer("revoke", workspaceId, id);
      },
    },
    overlapped: () => overlapped,
  };
}

async function actions(answers) {
  const { createBulkInvitationActions } = await load();
  const harness = makeDeps(answers);
  return { ...harness, actions: createBulkInvitationActions(harness.deps) };
}

const notFound = () => new CloudApiError("Invitation not found", 404);

test("resends one at a time in order", async () => {
  const { actions: bulk, calls, overlapped } = await actions();

  const outcome = await bulk.resendInvitations("ws-1", ["a", "b", "c"]);

  assert.deepEqual(calls, [
    ["resend", "ws-1", "a"],
    ["resend", "ws-1", "b"],
    ["resend", "ws-1", "c"],
  ]);
  assert.equal(overlapped(), false);
  assert.deepEqual(outcome, { done: ["a", "b", "c"], noEmail: [], failed: [] });
});

test("email not delivered is done and listed in noEmail", async () => {
  const { actions: bulk } = await actions({ b: { email_sent: false } });

  const outcome = await bulk.resendInvitations("ws-1", ["a", "b"]);

  assert.deepEqual(outcome, { done: ["a", "b"], noEmail: ["b"], failed: [] });
});

test("a canceled invitation already gone counts as canceled", async () => {
  const { actions: bulk } = await actions({ a: notFound() });

  const outcome = await bulk.cancelInvitations("ws-1", ["a", "b"]);

  assert.deepEqual(outcome, { done: ["a", "b"], noEmail: [], failed: [] });
});

test("a resent invitation already gone is a failure", async () => {
  const { actions: bulk } = await actions({ a: notFound() });

  const outcome = await bulk.resendInvitations("ws-1", ["a", "b"]);

  assert.deepEqual(outcome, {
    done: ["b"],
    noEmail: [],
    failed: [{ id: "a", error: { kind: "gone" } }],
  });
});

test("an unrelated failure does not stop the others", async () => {
  const { actions: bulk, calls } = await actions({
    a: new CloudApiError("Invitation already accepted", 400),
  });

  const outcome = await bulk.cancelInvitations("ws-1", ["a", "b"]);

  assert.equal(calls.length, 2);
  assert.deepEqual(outcome.done, ["b"]);
  assert.deepEqual(outcome.failed, [
    { id: "a", error: { kind: "refused", message: "Invitation already accepted" } },
  ]);
});

test("a request that is not a server answer is a plain failure", async () => {
  const { actions: bulk } = await actions({ a: new Error("network down") });

  const outcome = await bulk.resendInvitations("ws-1", ["a"]);

  assert.deepEqual(outcome.failed, [{ id: "a", error: { kind: "failed" } }]);
});

test("stops asking after permission is lost", async () => {
  const { actions: bulk, calls } = await actions({ b: new CloudApiError("Forbidden", 403) });

  const outcome = await bulk.resendInvitations("ws-1", ["a", "b", "c", "d"]);

  assert.deepEqual(
    calls.map(([, , id]) => id),
    ["a", "b"]
  );
  assert.deepEqual(outcome.done, ["a"]);
  assert.deepEqual(outcome.failed, [
    { id: "b", error: { kind: "notAllowed" } },
    { id: "c", error: { kind: "notAllowed" } },
    { id: "d", error: { kind: "notAllowed" } },
  ]);
});

test("required single sign-on answers the rest without asking", async () => {
  const { actions: bulk, calls } = await actions({
    a: new CloudApiError("SSO required", 403, "SSO_REQUIRED"),
  });

  const outcome = await bulk.cancelInvitations("ws-1", ["a", "b"]);

  assert.equal(calls.length, 1);
  assert.deepEqual(outcome.failed, [
    { id: "a", error: { kind: "ssoRequired" } },
    { id: "b", error: { kind: "ssoRequired" } },
  ]);
});

test("a 429 stops the rest", async () => {
  const { actions: bulk, calls } = await actions({
    a: new CloudApiError("Too many invitations right now. Try again later.", 429),
  });

  const outcome = await bulk.resendInvitations("ws-1", ["a", "b", "c"]);

  assert.equal(calls.length, 1);
  const refused = {
    kind: "refused",
    message: "Too many invitations right now. Try again later.",
  };
  assert.deepEqual(outcome.failed, [
    { id: "a", error: refused },
    { id: "b", error: refused },
    { id: "c", error: refused },
  ]);
});

test("an abort stops before the next request", async () => {
  const { createBulkInvitationActions } = await load();
  const controller = new AbortController();
  const asked = [];
  const bulk = createBulkInvitationActions({
    resend: async (_workspaceId, id) => {
      asked.push(id);
      controller.abort();
      return { email_sent: true };
    },
    revoke: async () => undefined,
  });

  const outcome = await bulk.resendInvitations("ws-1", ["a", "b"], controller.signal);

  assert.deepEqual(asked, ["a"]);
  assert.deepEqual(outcome, { done: ["a"], noEmail: [], failed: [] });
});

test("a sign-in change during the run ends it", async () => {
  const { createBulkInvitationActions } = await load();
  const harness = makeDeps();
  let generation = 1;
  const bulk = createBulkInvitationActions({
    ...harness.deps,
    resend: async (workspaceId, id) => {
      const answer = await harness.deps.resend(workspaceId, id);
      generation = 2;
      return answer;
    },
    authGeneration: () => generation,
  });

  const outcome = await bulk.resendInvitations("ws-1", ["a", "b"]);

  assert.equal(harness.calls.length, 1);
  assert.deepEqual(outcome.done, ["a"]);
  assert.deepEqual(outcome.failed, [{ id: "b", error: { kind: "failed" } }]);
});
