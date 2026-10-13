// Slack Web API replies for the connector tests. The shapes match responses
// recorded from the test workspace (plan Task 3); ids, names and tokens are
// synthetic. Never paste a real token, id or workspace name here.
const NOW = 1_800_000_000_000;

const FIXTURES = {
  exchange: {
    ok: true,
    app_id: "A0TEST",
    authed_user: {
      id: "U0CHAD",
      scope: "chat:write,channels:read,groups:read,im:write,users:read,users:read.email",
      access_token: "xoxe.xoxp-1-test-access",
      token_type: "user",
      refresh_token: "xoxe-1-test-refresh",
      expires_in: 43200,
    },
    team: { id: "T0TEST", name: "Acme Test" },
    enterprise: null,
    is_enterprise_install: false,
  },
  refresh: {
    ok: true,
    app_id: "A0TEST",
    user_id: "U0CHAD",
    scope: "chat:write,channels:read,groups:read,im:write,users:read,users:read.email",
    token_type: "user",
    access_token: "xoxe.xoxp-1-test-access-2",
    refresh_token: "xoxe-1-test-refresh-2",
    expires_in: 43200,
    team: { id: "T0TEST", name: "Acme Test" },
    enterprise: null,
    is_enterprise_install: false,
  },
  authTest: {
    ok: true,
    url: "https://acme-test.slack.com/",
    team: "Acme Test",
    user: "chad",
    team_id: "T0TEST",
    user_id: "U0CHAD",
    is_enterprise_install: false,
  },
  channels: {
    ok: true,
    channels: [
      {
        id: "C0ENG",
        name: "eng",
        is_channel: true,
        is_private: false,
        is_archived: false,
      },
      {
        id: "C0ENGBE",
        name: "eng-backend",
        is_channel: true,
        is_private: false,
        is_archived: false,
      },
      {
        id: "G0LEADS",
        name: "leads",
        is_channel: true,
        is_private: true,
        is_archived: false,
      },
    ],
    response_metadata: { next_cursor: "" },
  },
  people: {
    ok: true,
    members: [
      {
        id: "U0CHAD",
        name: "chad",
        deleted: false,
        is_bot: false,
        profile: { real_name: "Chad Test", display_name: "chad" },
      },
      {
        id: "U0GABE",
        name: "gabe",
        deleted: false,
        is_bot: false,
        profile: { real_name: "Gabe Smith", display_name: "gabe" },
      },
      {
        id: "U0GABRIEL",
        name: "gstone",
        deleted: false,
        is_bot: false,
        profile: { real_name: "Gabriel Stone", display_name: "gstone" },
      },
      {
        id: "USLACKBOT",
        name: "slackbot",
        deleted: false,
        is_bot: false,
        profile: { real_name: "Slackbot", display_name: "Slackbot" },
      },
      {
        id: "B0HELPER",
        name: "helper",
        deleted: false,
        is_bot: true,
        profile: { real_name: "Helper Bot", display_name: "helper" },
      },
      {
        id: "U0GONE",
        name: "gformer",
        deleted: true,
        is_bot: false,
        profile: { real_name: "Gabe Former", display_name: "gformer" },
      },
    ],
    response_metadata: { next_cursor: "" },
  },
  lookupGabe: {
    ok: true,
    user: {
      id: "U0GABE",
      name: "gabe",
      deleted: false,
      is_bot: false,
      profile: { real_name: "Gabe Smith", display_name: "gabe" },
    },
  },
  dmOpen: { ok: true, channel: { id: "D0GABE" } },
  posted: {
    ok: true,
    channel: "C0ENG",
    ts: "1727200000.123456",
    message: { type: "message", user: "U0CHAD", ts: "1727200000.123456" },
  },
  postedDm: {
    ok: true,
    channel: "D0GABE",
    ts: "1727200001.000100",
    message: { type: "message", user: "U0CHAD", ts: "1727200001.000100" },
  },
};

const CONNECTED = {
  accessToken: "xoxe.xoxp-1-test-access",
  refreshToken: "xoxe-1-test-refresh",
  expiresAt: NOW + 60 * 60 * 1000,
  refreshIssuedAt: NOW - 60 * 1000,
  userId: "U0CHAD",
  userName: "chad",
  teamId: "T0TEST",
  teamName: "Acme Test",
  teamUrl: "https://acme-test.slack.com/",
  needsReconnect: false,
};

// What a pending Slack action carries for CONNECTED in its slot at generation 1.
const BINDING = {
  ownerAccountId: "acct-1",
  accountId: "U0CHAD",
  workspaceId: "T0TEST",
  generation: 1,
};

// A scripted Slack: each method answers with its queued replies in order,
// and the last reply repeats.
function fakeSlackFetch(script) {
  const calls = [];
  const queues = new Map(Object.entries(script).map(([method, replies]) => [method, [...replies]]));
  const fetchImpl = async (url, init) => {
    const method = url.slice("https://slack.com/api/".length);
    calls.push({
      method,
      params: Object.fromEntries(new URLSearchParams(init.body)),
      authorization: init.headers.Authorization ?? null,
      contentType: init.headers["Content-Type"] ?? null,
    });
    const queue = queues.get(method);
    if (!queue || queue.length === 0) throw new Error(`unscripted Slack call: ${method}`);
    const reply = queue.length > 1 ? queue.shift() : queue[0];
    // Lets a test change state while this request is in flight.
    if (typeof reply.during === "function") reply.during();
    if (reply.throw) throw reply.throw;
    return new Response(reply.rawBody ?? JSON.stringify(reply.body ?? {}), {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json", ...(reply.headers ?? {}) },
    });
  };
  return { fetchImpl, calls, methods: () => calls.map((call) => call.method) };
}

const ok = (body) => ({ body });
const slackError = (error, extra = {}) => ({ body: { ok: false, error, ...extra } });
const httpStatus = (status, headers = {}) => ({
  status,
  headers,
  body: { ok: false, error: status === 429 ? "ratelimited" : "http_error" },
});
const reset = () => ({ throw: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }) });
const offline = () => ({
  throw: Object.assign(new Error("getaddrinfo ENOTFOUND slack.com"), { code: "ENOTFOUND" }),
});

// Same shape as connectorCredentials (plan Task 12), in memory. `initial`
// becomes the `connectorId` login of `accountId` at generation 1.
function memoryCredentials(initial = null, { accountId = "acct-1", connectorId = "slack" } = {}) {
  const slots = new Map();
  let active = accountId;
  const saves = [];
  const keyOf = (account, connectorId) => `${account}:${connectorId}`;
  const generation = (account, connectorId) =>
    account ? (slots.get(keyOf(account, connectorId))?.generation ?? 0) : 0;
  const refuse = (code) => {
    throw Object.assign(new Error(code), { code });
  };
  const expect = (account, connectorId, expected) => {
    if (!account) refuse("signed_out");
    if (generation(account, connectorId) !== expected) refuse("connection_changed");
  };
  if (initial) slots.set(keyOf(accountId, connectorId), { credential: initial, generation: 1 });
  return {
    saves,
    switchAccount: (next) => {
      active = next;
    },
    activeAccountId: () => active,
    generation,
    read: (account, connectorId) => {
      const slot = account ? slots.get(keyOf(account, connectorId)) : null;
      return slot?.credential ? { credential: slot.credential, generation: slot.generation } : null;
    },
    replace: (account, connectorId, credential, expected) => {
      expect(account, connectorId, expected);
      slots.set(keyOf(account, connectorId), { credential, generation: expected + 1 });
      return expected + 1;
    },
    save: (account, connectorId, credential, expected) => {
      expect(account, connectorId, expected);
      saves.push(credential);
      slots.set(keyOf(account, connectorId), { credential, generation: expected });
    },
    clear: (account, connectorId, expected) => {
      expect(account, connectorId, expected);
      slots.set(keyOf(account, connectorId), { credential: null, generation: expected + 1 });
    },
    readAllAccounts: (connectorId) =>
      [...slots]
        .filter(([key, slot]) => key.endsWith(`:${connectorId}`) && slot.credential)
        .map(([, slot]) => slot.credential),
  };
}

module.exports = {
  NOW,
  FIXTURES,
  CONNECTED,
  BINDING,
  fakeSlackFetch,
  ok,
  slackError,
  httpStatus,
  reset,
  offline,
  memoryCredentials,
};
