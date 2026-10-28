const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/services/invitePeople.ts");
const { CloudApiError } = require("../../src/services/cloudApi.ts");

const BATCH_STATUSES = [
  "invited",
  "invalid_email",
  "already_member",
  "already_invited",
  "directory_required",
];

// Records every batch request; an answer per address (a status, or an Error to reject the
// whole request) defaults to a sent invitation.
function makeSendBatch(answers = {}) {
  const calls = [];
  const sendBatch = async (workspaceId, input, authGeneration) => {
    calls.push({ workspaceId, input, authGeneration });
    await new Promise((resolve) => setTimeout(resolve, 1));
    const failing = input.emails.map((email) => answers[email]).find((a) => a instanceof Error);
    if (failing) throw failing;
    return {
      results: input.emails
        .filter((email) => answers[email] !== "missing")
        .map((email) => {
          const answer = answers[email];
          const status = typeof answer === "string" ? answer : (answer?.status ?? "invited");
          return {
            email,
            status,
            ...(status === "invited" ? { email_sent: answer?.email_sent ?? true } : {}),
          };
        }),
      seats_used: 1,
      seat_limit: 500,
    };
  };
  return { sendBatch, calls };
}

async function run(answers, input, authGeneration = () => 7) {
  const { createInvitePeople } = await load();
  const harness = makeSendBatch(answers);
  const results = [];
  await createInvitePeople({ sendBatch: harness.sendBatch, authGeneration }).sendInvitations({
    workspaceId: "ws-1",
    role: "member",
    onResult: (email, outcome) => results.push([email, outcome]),
    ...input,
  });
  return { ...harness, results };
}

const addresses = (count) => Array.from({ length: count }, (_, index) => `p${index}@x.com`);

test("one request carries every address", async () => {
  const emails = addresses(30);
  const { calls, results } = await run({}, { emails });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].input.emails, emails);
  assert.deepEqual(
    results.map(([email]) => email),
    emails
  );
});

test("120 addresses go in two requests in order", async () => {
  const { MAX_INVITE_RECIPIENTS } = await import("../../src/lib/inviteFlow.ts");
  assert.equal(MAX_INVITE_RECIPIENTS, 100);
  const emails = addresses(120);
  const { calls, results } = await run({}, { emails });
  assert.deepEqual(
    calls.map((call) => call.input.emails),
    [emails.slice(0, 100), emails.slice(100)]
  );
  assert.deepEqual(
    results.map(([email]) => email),
    emails
  );
});

test("teams and spaces are forwarded only when present", async () => {
  const withBoth = await run({}, { emails: ["a@x.com"], teamIds: ["t1"], spaceIds: ["s1"] });
  assert.deepEqual(withBoth.calls[0], {
    workspaceId: "ws-1",
    input: { emails: ["a@x.com"], role: "member", team_ids: ["t1"], space_ids: ["s1"] },
    authGeneration: 7,
  });
  const empty = await run({}, { emails: ["a@x.com"], teamIds: [], spaceIds: [] });
  assert.deepEqual(empty.calls[0].input, { emails: ["a@x.com"], role: "member" });
  assert.ok(!("team_ids" in empty.calls[0].input));
  assert.ok(!("space_ids" in empty.calls[0].input));
});

test("each address gets its own outcome", async () => {
  const emails = ["a@x.com", "b@x.com", "c@x.com", "d@x.com", "e@x.com", "f@x.com"];
  const { results } = await run(
    {
      "a@x.com": "invited",
      "b@x.com": { status: "invited", email_sent: false },
      "c@x.com": "invalid_email",
      "d@x.com": "already_member",
      "e@x.com": "already_invited",
      "f@x.com": "directory_required",
    },
    { emails }
  );
  assert.deepEqual(
    results.map(([, outcome]) => outcome),
    [
      { ok: true, emailSent: true },
      { ok: true, emailSent: false },
      { ok: false, kind: "invalid" },
      { ok: false, kind: "alreadyMember" },
      { ok: false, kind: "alreadyInvited" },
      { ok: false, kind: "directoryRequired" },
    ]
  );
  assert.equal(BATCH_STATUSES.length, 5);
});

test("results match addresses regardless of case", async () => {
  const { createInvitePeople } = await load();
  const results = [];
  await createInvitePeople({
    sendBatch: async () => ({
      results: [{ email: "SAM@X.com", status: "invited", email_sent: true }],
      seats_used: 1,
      seat_limit: 500,
    }),
    authGeneration: () => 7,
  }).sendInvitations({
    workspaceId: "ws-1",
    role: "member",
    emails: ["sam@x.com"],
    onResult: (email, outcome) => results.push([email, outcome]),
  });
  assert.deepEqual(results, [["sam@x.com", { ok: true, emailSent: true }]]);
});

test("email_sent missing is a sent result with emailSent false", async () => {
  const { createInvitePeople } = await load();
  const results = [];
  await createInvitePeople({
    sendBatch: async () => ({
      results: [{ email: "a@x.com", status: "invited" }],
      seats_used: 1,
      seat_limit: 500,
    }),
    authGeneration: () => 7,
  }).sendInvitations({
    workspaceId: "ws-1",
    role: "member",
    emails: ["a@x.com"],
    onResult: (email, outcome) => results.push([email, outcome]),
  });
  assert.deepEqual(results, [["a@x.com", { ok: true, emailSent: false }]]);
});

test("an address missing from the answer is a failed request", async () => {
  const { results } = await run({ "b@x.com": "missing" }, { emails: ["a@x.com", "b@x.com"] });
  assert.deepEqual(
    results.map(([, outcome]) => outcome),
    [
      { ok: true, emailSent: true },
      { ok: false, kind: "requestFailed" },
    ]
  );
});

test("a seat refusal marks every address and carries available", async () => {
  const error = new CloudApiError("No seats", 400, "seat_limit_reached", { available: 4 });
  const { results, calls } = await run({ "a@x.com": error }, { emails: ["a@x.com", "b@x.com"] });
  assert.equal(calls.length, 1);
  assert.deepEqual(
    results.map(([, outcome]) => outcome),
    Array(2).fill({ ok: false, kind: "seatLimit", available: 4 })
  );
});

test("a dropped connection fails the chunk, retryable", async () => {
  const { results } = await run(
    { "a@x.com": new CloudApiError("Network down", 0) },
    { emails: ["a@x.com", "b@x.com"] }
  );
  assert.deepEqual(
    results.map(([, outcome]) => outcome),
    Array(2).fill({ ok: false, kind: "requestFailed" })
  );
  const { isRetryableFailure } = await import("../../src/lib/inviteFlow.ts");
  assert.equal(isRetryableFailure("requestFailed"), true);
});

test("a rate limit ends the batch and is retryable", async () => {
  const emails = addresses(150);
  const { results, calls } = await run(
    { "p0@x.com": new CloudApiError("Too many", 429, "rate_limited") },
    { emails }
  );
  assert.equal(calls.length, 1);
  assert.equal(results.length, 150);
  assert.ok(results.every(([, outcome]) => !outcome.ok && outcome.kind === "rateLimited"));
  const { isRetryableFailure } = await import("../../src/lib/inviteFlow.ts");
  assert.equal(isRetryableFailure("rateLimited"), true);
});

test("a throwing onResult doesn't stop the others", async () => {
  const { createInvitePeople } = await load();
  const harness = makeSendBatch();
  const seen = [];
  await createInvitePeople({
    sendBatch: harness.sendBatch,
    authGeneration: () => 7,
  }).sendInvitations({
    workspaceId: "ws-1",
    role: "member",
    emails: ["a@x.com", "b@x.com", "c@x.com"],
    onResult: (email) => {
      seen.push(email);
      if (email === "a@x.com") throw new Error("listener failed");
    },
  });
  assert.deepEqual(seen, ["a@x.com", "b@x.com", "c@x.com"]);
});

test("abort before sending sends nothing", async () => {
  const controller = new AbortController();
  controller.abort();
  const { calls, results } = await run({}, { emails: ["a@x.com"], signal: controller.signal });
  assert.equal(calls.length, 0);
  assert.deepEqual(results, []);
});

// Two chunks, so the first request's refusal either ends the run or lets the second go ahead.
const TWO_CHUNKS = addresses(150);

test("later chunks share the answer when permission is lost or single sign-on is required", async () => {
  for (const [error, kind] of [
    [new CloudApiError("Forbidden", 403), "notAllowed"],
    [new CloudApiError("Sign in with company SSO", 403, "SSO_REQUIRED"), "ssoRequired"],
    [new CloudApiError("No seats", 400, "seat_limit_reached", { available: 4 }), "seatLimit"],
  ]) {
    const { results, calls } = await run({ "p0@x.com": error }, { emails: TWO_CHUNKS });
    assert.equal(calls.length, 1, kind);
    assert.equal(results.length, 150, kind);
    assert.ok(
      results.every(([, outcome]) => !outcome.ok && outcome.kind === kind),
      kind
    );
  }
});

test("a refusal of one chunk's request doesn't stop the next chunk", async () => {
  const { results, calls } = await run(
    { "p0@x.com": new CloudApiError("That address can't be invited", 409) },
    { emails: TWO_CHUNKS }
  );
  assert.equal(calls.length, 2);
  assert.deepEqual(results[0], [
    "p0@x.com",
    { ok: false, kind: "refused", message: "That address can't be invited" },
  ]);
  assert.deepEqual(results[149], ["p149@x.com", { ok: true, emailSent: true }]);
});

test("a 400 about the request itself stops the batch", async () => {
  const message = "One or more teams do not belong to this workspace";
  const { results, calls } = await run(
    { "p0@x.com": new CloudApiError(message, 400) },
    { emails: TWO_CHUNKS }
  );
  assert.equal(calls.length, 1);
  assert.equal(results.length, 150);
  assert.ok(
    results.every(
      ([, outcome]) => !outcome.ok && outcome.kind === "refused" && outcome.message === message
    )
  );
});

test("an expired or replaced sign-in stops the batch", async () => {
  for (const error of [
    new CloudApiError("Unauthorized", 401, "AUTH_EXPIRED"),
    new CloudApiError("Account changed", 409, "AUTH_CONTEXT_CHANGED"),
  ]) {
    const { results, calls } = await run({ "p0@x.com": error }, { emails: TWO_CHUNKS });
    assert.equal(calls.length, 1);
    assert.equal(results.length, 150);
    assert.ok(results.every(([, outcome]) => !outcome.ok && outcome.kind === "sessionExpired"));
  }
});

test("every request of a run carries the sign-in it started under", async () => {
  let generation = 7;
  const { calls } = await run({}, { emails: TWO_CHUNKS }, () => generation++);
  assert.deepEqual(
    calls.map((call) => call.authGeneration),
    [7, 7]
  );
});

test("an abort after a request sends nothing more and reports nothing more", async () => {
  const controller = new AbortController();
  const { createInvitePeople } = await load();
  const harness = makeSendBatch();
  const results = [];
  await createInvitePeople({
    sendBatch: async (...args) => {
      const answer = await harness.sendBatch(...args);
      controller.abort();
      return answer;
    },
    authGeneration: () => 7,
  }).sendInvitations({
    workspaceId: "ws-1",
    role: "member",
    emails: TWO_CHUNKS,
    signal: controller.signal,
    onResult: (email, outcome) => results.push([email, outcome]),
  });
  assert.equal(harness.calls.length, 1);
  assert.deepEqual(results, []);
});
