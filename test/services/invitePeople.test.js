const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/services/invitePeople.ts");
const { CloudApiError } = require("../../src/services/cloudApi.ts");

// Records start/end of every request so overlap and order can be asserted.
function makeSend(answers = {}) {
  const events = [];
  const inputs = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const generations = [];
  const send = async (workspaceId, input, authGeneration) => {
    events.push(`start:${input.email}`);
    inputs.push({ workspaceId, input });
    generations.push(authGeneration);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
    events.push(`end:${input.email}`);
    const answer = answers[input.email];
    if (answer instanceof Error) throw answer;
    return { email_sent: answer?.email_sent ?? true };
  };
  return { send, events, inputs, generations, maxInFlight: () => maxInFlight };
}

async function run(answers, input, authGeneration = () => 7) {
  const { createInvitePeople } = await load();
  const harness = makeSend(answers);
  const results = [];
  await createInvitePeople({ send: harness.send, authGeneration }).sendInvitations({
    workspaceId: "ws-1",
    role: "member",
    onResult: (email, outcome) => results.push([email, outcome]),
    ...input,
  });
  return { ...harness, results };
}

test("sends one at a time in order", async () => {
  const emails = ["a@x.com", "b@x.com", "c@x.com"];
  const { events, maxInFlight, results } = await run({}, { emails });
  assert.equal(maxInFlight(), 1);
  assert.deepEqual(events, [
    "start:a@x.com",
    "end:a@x.com",
    "start:b@x.com",
    "end:b@x.com",
    "start:c@x.com",
    "end:c@x.com",
  ]);
  assert.deepEqual(
    results.map(([email]) => email),
    emails
  );
});

test("teams and spaces are forwarded only when present", async () => {
  const withBoth = await run({}, { emails: ["a@x.com"], teamIds: ["t1"], spaceIds: ["s1"] });
  assert.deepEqual(withBoth.inputs[0], {
    workspaceId: "ws-1",
    input: { email: "a@x.com", role: "member", team_ids: ["t1"], space_ids: ["s1"] },
  });
  const empty = await run({}, { emails: ["a@x.com"], teamIds: [], spaceIds: [] });
  assert.deepEqual(empty.inputs[0].input, { email: "a@x.com", role: "member" });
  assert.ok(!("team_ids" in empty.inputs[0].input));
  assert.ok(!("space_ids" in empty.inputs[0].input));
});

test("email_sent false is a sent result with emailSent false", async () => {
  const { results } = await run({ "a@x.com": { email_sent: false } }, { emails: ["a@x.com"] });
  assert.deepEqual(results, [["a@x.com", { ok: true, emailSent: false }]]);
});

test("a refused address does not stop the rest", async () => {
  const { results, inputs } = await run(
    { "b@x.com": new CloudApiError("Invalid email", 400, "invalid_email") },
    { emails: ["a@x.com", "b@x.com", "c@x.com"] }
  );
  assert.equal(inputs.length, 3);
  assert.deepEqual(
    results.map(([, outcome]) => outcome),
    [
      { ok: true, emailSent: true },
      { ok: false, kind: "invalid" },
      { ok: true, emailSent: true },
    ]
  );
});

test("stops calling after permission is lost", async () => {
  const { results, inputs } = await run(
    { "b@x.com": new CloudApiError("Forbidden", 403) },
    { emails: ["a@x.com", "b@x.com", "c@x.com"] }
  );
  assert.equal(inputs.length, 2);
  assert.deepEqual(results[1], ["b@x.com", { ok: false, kind: "notAllowed" }]);
  assert.deepEqual(results[2], ["c@x.com", { ok: false, kind: "notAllowed" }]);
});

test("stops calling after the seat limit is reached", async () => {
  const { results, inputs } = await run(
    { "a@x.com": new CloudApiError("No seats", 403, "seat_limit_reached") },
    { emails: ["a@x.com", "b@x.com"] }
  );
  assert.equal(inputs.length, 1);
  assert.deepEqual(
    results.map(([, outcome]) => outcome),
    [
      { ok: false, kind: "seatLimit" },
      { ok: false, kind: "seatLimit" },
    ]
  );
});

test("stops calling once single sign-on is required", async () => {
  const { results, inputs } = await run(
    { "a@x.com": new CloudApiError("Sign in with company SSO", 403, "SSO_REQUIRED") },
    { emails: ["a@x.com", "b@x.com"] }
  );
  assert.equal(inputs.length, 1);
  assert.deepEqual(
    results.map(([, outcome]) => outcome),
    [
      { ok: false, kind: "ssoRequired" },
      { ok: false, kind: "ssoRequired" },
    ]
  );
});

test("an address-specific refusal carries the server's reason and doesn't stop the rest", async () => {
  const { results, inputs } = await run(
    { "a@x.com": new CloudApiError("That address can't be invited", 409) },
    { emails: ["a@x.com", "b@x.com"] }
  );
  assert.equal(inputs.length, 2);
  assert.deepEqual(results, [
    ["a@x.com", { ok: false, kind: "refused", message: "That address can't be invited" }],
    ["b@x.com", { ok: true, emailSent: true }],
  ]);
});

test("a 400 about the request itself stops the batch", async () => {
  const message = "One or more teams do not belong to this workspace";
  const { results, inputs } = await run(
    { "a@x.com": new CloudApiError(message, 400) },
    { emails: ["a@x.com", "b@x.com", "c@x.com"] }
  );
  assert.equal(inputs.length, 1);
  assert.deepEqual(
    results.map(([, outcome]) => outcome),
    Array(3).fill({ ok: false, kind: "refused", message })
  );
});

test("an expired or replaced sign-in stops the batch", async () => {
  for (const error of [
    new CloudApiError("Unauthorized", 401, "AUTH_EXPIRED"),
    new CloudApiError("Account changed", 409, "AUTH_CONTEXT_CHANGED"),
  ]) {
    const { results, inputs } = await run({ "a@x.com": error }, { emails: ["a@x.com", "b@x.com"] });
    assert.equal(inputs.length, 1);
    assert.deepEqual(
      results.map(([, outcome]) => outcome),
      [
        { ok: false, kind: "sessionExpired" },
        { ok: false, kind: "sessionExpired" },
      ]
    );
  }
});

test("every request of a batch carries the sign-in it started under", async () => {
  let generation = 7;
  const { generations } = await run({}, { emails: ["a@x.com", "b@x.com"] }, () => generation++);
  assert.deepEqual(generations, [7, 7]);
});

test("an aborted run sends nothing more and reports nothing more", async () => {
  const controller = new AbortController();
  const { createInvitePeople } = await load();
  const harness = makeSend();
  const results = [];
  await createInvitePeople({
    send: async (...args) => {
      const answer = await harness.send(...args);
      controller.abort();
      return answer;
    },
    authGeneration: () => 7,
  }).sendInvitations({
    workspaceId: "ws-1",
    role: "member",
    emails: ["a@x.com", "b@x.com"],
    signal: controller.signal,
    onResult: (email, outcome) => results.push([email, outcome]),
  });
  assert.equal(harness.inputs.length, 1);
  assert.deepEqual(results, []);
});
