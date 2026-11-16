// Linear replies for the Linear connector tests. The shapes follow what a
// real Linear workspace answered; ids, names and tokens are synthetic.
// Never paste a real token, id or name here.
//
// FIXTURES and gqlError's error envelope are the two places that assume
// Linear's wire format. When Linear's answers change, change them here;
// the tests read only these.
const { NOW, memoryCredentials } = require("./slackFixtures");

const FORM = "application/x-www-form-urlencoded";

// Response bodies as Linear sends them.
const FIXTURES = {
  // The code exchange. Linear returns `scope` as a
  // space-separated string, not an array or comma list; linearAuth accepts
  // all three.
  exchange: {
    access_token: "access-1",
    token_type: "Bearer",
    expires_in: 86399,
    scope: "comments:create issues:create read",
    refresh_token: "refresh-1",
  },
  // A refresh. The refresh token rotates, so a
  // refresh always returns a new one.
  refresh: {
    access_token: "access-2",
    token_type: "Bearer",
    expires_in: 86399,
    scope: "comments:create issues:create read",
    refresh_token: "refresh-2",
  },
  // `query LinearIdentity { viewer { id name } organization { id name urlKey } }`
  identity: {
    viewer: { id: "user-1", name: "Dana" },
    organization: { id: "org-1", name: "Acme", urlKey: "acme" },
  },
  // `query LinearTeams { teams(first: 250) { nodes { id key name } pageInfo { hasNextPage } } }`
  teams: {
    teams: {
      nodes: [
        { id: "team-eng", key: "ENG", name: "Engineering" },
        { id: "team-des", key: "DES", name: "Design" },
      ],
      pageInfo: { hasNextPage: false },
    },
  },
  // `query LinearTeamProjects($teamId: String!) { team(id: $teamId) { projects(first: 250) { … } } }`
  projects: {
    team: {
      projects: {
        nodes: [
          { id: "proj-q4", name: "Q4 launch" },
          { id: "proj-onb", name: "Onboarding" },
        ],
        pageInfo: { hasNextPage: false },
      },
    },
  },
};

// A Linear login as linearAuth saves it. Pass it to
// memoryCredentials(CONNECTED, { connectorId: "linear" }).
const CONNECTED = {
  accessToken: "access-1",
  refreshToken: "refresh-1",
  expiresAt: NOW + 60 * 60 * 1000,
  userId: "user-1",
  userName: "Dana",
  organizationId: "org-1",
  organizationName: "Acme",
  organizationUrlKey: "acme",
  scope: "read,issues:create,comments:create",
  needsReconnect: false,
};

// What a pending Linear action carries for CONNECTED in its slot at generation 1.
const BINDING = {
  ownerAccountId: "acct-1",
  accountId: "user-1",
  workspaceId: "org-1",
  generation: 1,
};

// A stand-in for oauthLoopbackFlow.js's OAuthFlowError, carrying the
// redirect code the connector manager reads.
class FakeFlowError extends Error {
  constructor(redirectCode, message) {
    super(message);
    this.redirectCode = redirectCode;
  }
}

// "query LinearTeams { … }" → "LinearTeams". Every query this connector
// sends is a named operation, so the fake can script replies by name.
function operationName(query) {
  return /^\s*(?:query|mutation)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(String(query ?? ""))?.[1] ?? null;
}

// A scripted Linear. `script` is keyed by URL path:
//   "/graphql": { <operation name>: [replies] }
//   "/oauth/token": [replies]
//   "/oauth/revoke": [replies]
// Each queue answers in order and its last reply repeats. A reply is
// { body?, rawBody?, status?, headers?, throw?, during?() }; status defaults
// to 200 and body to {}. Every call is recorded before its reply is chosen,
// so an unscripted call (which throws, like a network failure) still shows.
function fakeLinearFetch(script) {
  const calls = [];
  const queues = new Map();
  for (const [path, replies] of Object.entries(script)) {
    if (Array.isArray(replies)) queues.set(path, [...replies]);
    else for (const [op, list] of Object.entries(replies)) queues.set(`${path}#${op}`, [...list]);
  }
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname;
    const contentType = init.headers["Content-Type"] ?? null;
    const json = contentType === "application/json" ? JSON.parse(init.body) : null;
    const operation = path === "/graphql" ? operationName(json?.query) : null;
    calls.push({
      path,
      operation,
      variables: json?.variables ?? null,
      form: contentType === FORM ? Object.fromEntries(new URLSearchParams(init.body)) : null,
      authorization: init.headers.Authorization ?? null,
    });
    const key = path === "/graphql" ? `${path}#${operation}` : path;
    const queue = queues.get(key);
    if (!queue || queue.length === 0) throw new Error(`unscripted Linear call: ${key}`);
    const reply = queue.length > 1 ? queue.shift() : queue[0];
    // Lets a test change state while this request is in flight.
    if (typeof reply.during === "function") reply.during();
    if (reply.throw) throw reply.throw;
    return new Response(reply.rawBody ?? JSON.stringify(reply.body ?? {}), {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json", ...(reply.headers ?? {}) },
    });
  };
  return {
    fetchImpl,
    calls,
    operations: () => calls.map((call) => call.operation ?? call.path),
  };
}

// A GraphQL success: { data }.
const gql = (data, { status = 200, headers = {} } = {}) => ({
  body: { data },
  status,
  headers,
});

// A GraphQL error answer. Linear puts the code in
// errors[].extensions.code, with a readable extensions.type; pass
// { extensions } to send another shape, and { data } for a partial answer.
const gqlError = (
  code,
  { status = 200, headers = {}, data = null, extensions, message = "Synthetic error" } = {}
) => ({
  status,
  headers,
  body: {
    data,
    errors: [
      {
        message,
        extensions: extensions ?? { code, type: "synthetic", userPresentableMessage: message },
      },
    ],
  },
});

// A non-2xx with a GraphQL error body whose code no list names.
const httpStatus = (status, headers = {}) => ({
  status,
  headers,
  body: { errors: [{ message: "Synthetic error", extensions: { code: "SYNTHETIC_ERROR" } }] },
});
const reset = () => ({ throw: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }) });
const offline = () => ({
  throw: Object.assign(new Error("getaddrinfo ENOTFOUND api.linear.app"), { code: "ENOTFOUND" }),
});

module.exports = {
  NOW,
  FIXTURES,
  CONNECTED,
  BINDING,
  FakeFlowError,
  fakeLinearFetch,
  gql,
  gqlError,
  httpStatus,
  reset,
  offline,
  memoryCredentials,
};
