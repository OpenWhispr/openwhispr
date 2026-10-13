const test = require("node:test");
const assert = require("node:assert/strict");
const { NOW, FIXTURES, fakeSlackFetch, ok, slackError } = require("./slackFixtures");

const loadDirectory = () => import("../../../src/helpers/connectors/slackDirectory.js");
const loadApi = () => import("../../../src/helpers/connectors/slackApi.js");

async function setup(script) {
  const [{ createSlackDirectory }, { createSlackApi }] = await Promise.all([
    loadDirectory(),
    loadApi(),
  ]);
  const slack = fakeSlackFetch(script);
  const clock = { now: NOW };
  const directory = createSlackDirectory({
    api: createSlackApi({ fetchImpl: slack.fetchImpl, sleep: async () => {} }),
    now: () => clock.now,
  });
  return { directory, slack, clock };
}

test("channels page through cursors, skip archived ones, and stay cached for ten minutes", async () => {
  const page1 = {
    ok: true,
    channels: [FIXTURES.channels.channels[0]],
    response_metadata: { next_cursor: "c2" },
  };
  const page2 = {
    ok: true,
    channels: [
      FIXTURES.channels.channels[1],
      { id: "C0OLD", name: "old", is_archived: true, is_member: true },
    ],
    response_metadata: { next_cursor: "" },
  };
  const { directory, slack, clock } = await setup({
    "users.conversations": [ok(page1), ok(page2), ok(FIXTURES.channels)],
  });

  const first = await directory.channels("t", "k1");
  assert.deepEqual(
    first.items.map((channel) => channel.label),
    ["#eng", "#eng-backend"]
  );
  assert.equal(first.truncated, false);
  assert.equal(slack.calls[0].params.types, "public_channel,private_channel");
  assert.equal(slack.calls[0].params.exclude_archived, "true");
  assert.equal(slack.calls[1].params.cursor, "c2");

  await directory.channels("t", "k1");
  assert.equal(slack.calls.length, 2, "served from the cache");

  clock.now += 10 * 60 * 1000 + 1;
  const reloaded = await directory.channels("t", "k1");
  assert.equal(slack.calls.length, 3);
  assert.equal(reloaded.items.length, 3);
});

test("people skip bots, deleted users and Slackbot, and carry a handle hint", async () => {
  const { directory } = await setup({ "users.list": [ok(FIXTURES.people)] });

  const people = await directory.people("t", "k");

  assert.deepEqual(
    people.items.map((person) => person.id),
    ["U0CHAD", "U0GABE", "U0GABRIEL"]
  );
  assert.deepEqual(people.items[1], {
    id: "U0GABE",
    kind: "user",
    label: "Gabe Smith",
    hint: "Gabe Smith (@gabe)",
    names: ["gabe", "Gabe Smith"],
  });
});

test("a directory longer than ten pages is marked truncated", async () => {
  const endless = {
    ok: true,
    channels: [FIXTURES.channels.channels[0]],
    response_metadata: { next_cursor: "more" },
  };
  const { directory, slack } = await setup({ "users.conversations": [ok(endless)] });

  const result = await directory.channels("t", "k");

  assert.equal(result.truncated, true);
  assert.equal(slack.calls.length, 10);
});

test("a failed load is reported and not cached", async () => {
  const { directory, slack } = await setup({
    "users.conversations": [slackError("missing_scope"), ok(FIXTURES.channels)],
  });

  assert.deepEqual(await directory.channels("t", "k"), { ok: false, errorCode: "missing_scope" });
  assert.equal((await directory.channels("t", "k")).ok, true);
  assert.equal(slack.calls.length, 2);
});

test("an email finds a person; an unknown email is no match, not an error", async () => {
  const found = await setup({ "users.lookupByEmail": [ok(FIXTURES.lookupGabe)] });
  assert.equal(
    (await found.directory.personByEmail("t", "gabe@example.com")).candidate.id,
    "U0GABE"
  );
  assert.deepEqual(found.slack.calls[0].params, { email: "gabe@example.com" });

  const missing = await setup({ "users.lookupByEmail": [slackError("users_not_found")] });
  assert.deepEqual(await missing.directory.personByEmail("t", "nobody@example.com"), {
    ok: true,
    candidate: null,
  });
});

test("a new login never reads the old login's cache", async () => {
  const { directory, slack } = await setup({ "users.list": [ok(FIXTURES.people)] });
  await directory.people("t", "acct-1:T0TEST:U0CHAD:1");
  await directory.people("t", "acct-1:T0TEST:U0CHAD:2");
  assert.equal(slack.calls.length, 2);
});
