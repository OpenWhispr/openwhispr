// Google replies for the Gmail connector tests. The shapes match the
// responses recorded in plan Task 3 (<scratchpad>/gmail-decisions.md);
// addresses, ids and tokens are synthetic. Never paste a real token, id or
// address here.
const { NOW, memoryCredentials } = require("./slackFixtures");

const FORM = "application/x-www-form-urlencoded";

// A Gmail login as gmailAuth saves it (plan Task 8). Pass it to
// memoryCredentials(CONNECTED, { connectorId: "gmail" }).
const CONNECTED = {
  email: "you@example.test",
  sub: "sub-1",
  refreshToken: "refresh-1",
  accessToken: "access-1",
  expiresAt: NOW + 60 * 60 * 1000,
  scope: "openid email https://www.googleapis.com/auth/gmail.send",
  needsReconnect: false,
};

// What a pending Gmail action carries for CONNECTED in its slot at generation 1.
const BINDING = { ownerAccountId: "acct-1", accountId: "sub-1", generation: 1 };

// What Google's token endpoint returns for the three requested scopes: full
// URLs, space separated, in no fixed order ("email" becomes userinfo.email).
const GRANTED =
  "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/gmail.send";

// A stand-in for the real gmailAuth.js's OAuthFlowError, carrying the
// redirect code the caller reads.
class FakeFlowError extends Error {
  constructor(redirectCode, message) {
    super(message);
    this.redirectCode = redirectCode;
  }
}

// A scripted Google: each URL path answers with its queued replies in order,
// and the last reply repeats. Paths: "/gmail/v1/users/me/messages/send",
// "/token" and "/revoke".
function fakeGoogleFetch(script) {
  const calls = [];
  const queues = new Map(Object.entries(script).map(([path, replies]) => [path, [...replies]]));
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname;
    const contentType = init.headers["Content-Type"] ?? null;
    calls.push({
      path,
      form: contentType === FORM ? Object.fromEntries(new URLSearchParams(init.body)) : null,
      json: contentType === "application/json" ? JSON.parse(init.body) : null,
      authorization: init.headers.Authorization ?? null,
    });
    const queue = queues.get(path);
    if (!queue || queue.length === 0) throw new Error(`unscripted Google call: ${path}`);
    const reply = queue.length > 1 ? queue.shift() : queue[0];
    // Lets a test change state while this request is in flight.
    if (typeof reply.during === "function") reply.during();
    if (reply.throw) throw reply.throw;
    return new Response(reply.rawBody ?? JSON.stringify(reply.body ?? {}), {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json", ...(reply.headers ?? {}) },
    });
  };
  return { fetchImpl, calls, paths: () => calls.map((call) => call.path) };
}

const json = (body, status = 200, headers = {}) => ({ body, status, headers });
// Google's JSON error envelope, with a reason that maps to no specific code.
const httpStatus = (status, headers = {}) => ({
  status,
  headers,
  body: {
    error: {
      code: status,
      message: "Synthetic error",
      errors: [{ domain: "global", reason: "backendError", message: "Synthetic error" }],
    },
  },
});
const reset = () => ({ throw: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }) });
const offline = () => ({
  throw: Object.assign(new Error("getaddrinfo ENOTFOUND oauth2.googleapis.com"), {
    code: "ENOTFOUND",
  }),
});

// Google's recorded reply to a successful revoke: 200 with "{\n}".
const GOOGLE_REVOKE_OK = { status: 200, rawBody: "{\n}" };

// An unsigned id_token as the token endpoint returns it (header.payload.sig).
// gmailAuth reads the payload only; it trusts the token because it came
// straight from Google's token endpoint over TLS.
function idToken(payload) {
  const segment = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${segment({ alg: "RS256", kid: "test-key", typ: "JWT" })}.${segment(payload)}.test-signature`;
}

// The raw message Gmail received: headers unfolded, body base64-decoded.
function decodeMessage(raw) {
  const text = Buffer.from(raw, "base64url").toString("utf8");
  const split = text.indexOf("\r\n\r\n");
  return {
    headers: text
      .slice(0, split)
      .replace(/\r\n[ \t]/g, " ")
      .split("\r\n"),
    body: Buffer.from(text.slice(split + 4).replace(/\r\n/g, ""), "base64").toString("utf8"),
  };
}

function header(message, name) {
  return (
    message.headers.find((line) => line.toLowerCase().startsWith(`${name.toLowerCase()}:`)) ?? null
  );
}

module.exports = {
  NOW,
  CONNECTED,
  BINDING,
  GRANTED,
  FakeFlowError,
  fakeGoogleFetch,
  json,
  httpStatus,
  reset,
  offline,
  idToken,
  decodeMessage,
  header,
  memoryCredentials,
  GOOGLE_REVOKE_OK,
};
