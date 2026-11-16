// GitHub's device flow (spec §5.1): ask for a user code, then poll the token
// endpoint at GitHub's interval until the user enters the code, declines, or
// the code expires. No client secret: a GitHub App's device flow needs only
// the client id. Pure: the api, the clock and the sleep are injected.
const { abortableSleep } = require("./githubApi");

const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
// GitHub's documented defaults when a reply leaves them out.
const DEFAULT_INTERVAL_MS = 5000;
const DEFAULT_EXPIRES_IN_S = 900;
// slow_down: "5 extra seconds are added to the minimum interval".
const SLOW_DOWN_STEP_MS = 5000;
// The code is entered here; the renderer opens it, so nothing else is accepted.
const VERIFICATION_ORIGIN = "https://github.com/";

function codedError(code) {
  return Object.assign(new Error(code), { code });
}

// GitHub answered and said no (incorrect_device_code, unsupported_grant_type,
// a bare 4xx other than a 408 timeout), rather than being unreachable, out or
// throttled, which may pass.
function saidNo(result) {
  return (
    result.refused === true ||
    (/^http_4\d\d$/.test(result.errorCode ?? "") && result.errorCode !== "http_408")
  );
}

// Why no code could be shown. Only GitHub's own refusal is "didn't finish
// connecting": offline or throttled, the user never saw a code to enter.
function deviceCodeFailure(result) {
  if (result.errorCode === "device_flow_disabled") return "device_flow_disabled";
  if (result.rateLimited === true) return "rate_limited";
  if (result.errorCode === "bad_response" || saidNo(result)) return "token_exchange_failed";
  return "network";
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function createDeviceFlow({
  api,
  sleep: defaultSleep = abortableSleep,
  now: defaultNow = Date.now,
}) {
  function throwIfCancelled(signal) {
    if (signal?.aborted) throw codedError("oauth_cancelled");
  }

  async function startDeviceAuthorization({ clientId, signal, now = defaultNow } = {}) {
    throwIfCancelled(signal);
    const result = await api.deviceCode({ client_id: clientId }, { signal });
    throwIfCancelled(signal);
    if (!result.ok) throw codedError(deviceCodeFailure(result));
    const data = result.data;
    const verificationUri = data.verification_uri;
    if (
      typeof data.device_code !== "string" ||
      !data.device_code ||
      typeof data.user_code !== "string" ||
      !data.user_code ||
      typeof verificationUri !== "string" ||
      !verificationUri.startsWith(VERIFICATION_ORIGIN)
    ) {
      throw codedError("token_exchange_failed");
    }
    return {
      deviceCode: data.device_code,
      userCode: data.user_code,
      verificationUri,
      expiresAt: now() + positiveNumber(data.expires_in, DEFAULT_EXPIRES_IN_S) * 1000,
      intervalMs: positiveNumber(data.interval, DEFAULT_INTERVAL_MS / 1000) * 1000,
    };
  }

  // Resolves { ok: true, token } with GitHub's token reply (access_token,
  // expires_in, refresh_token, refresh_token_expires_in, …), or throws a
  // coded error: oauth_cancelled, code_expired, oauth_denied,
  // device_flow_disabled or token_exchange_failed.
  async function pollForToken({
    clientId,
    deviceCode,
    intervalMs,
    expiresAt,
    signal,
    sleep = defaultSleep,
    now = defaultNow,
  }) {
    let interval = positiveNumber(intervalMs, DEFAULT_INTERVAL_MS);
    for (;;) {
      throwIfCancelled(signal);
      const remaining = expiresAt - now();
      if (remaining <= 0) throw codedError("code_expired");
      // Never sleep past the code's expiry just to find it expired.
      await sleep(Math.min(interval, remaining), signal);
      throwIfCancelled(signal);
      if (now() >= expiresAt) throw codedError("code_expired");

      const result = await api.accessToken(
        { client_id: clientId, device_code: deviceCode, grant_type: DEVICE_GRANT_TYPE },
        { signal }
      );
      throwIfCancelled(signal);

      if (result.ok) {
        if (typeof result.data?.access_token === "string" && result.data.access_token) {
          return { ok: true, token: result.data };
        }
        throw codedError("token_exchange_failed");
      }
      switch (result.errorCode) {
        case "authorization_pending":
          continue;
        case "slow_down":
        // A bare 429 is GitHub throttling the poll without saying slow_down.
        case "http_429":
          interval = Math.max(interval + SLOW_DOWN_STEP_MS, positiveNumber(result.intervalMs, 0));
          continue;
        case "expired_token":
          throw codedError("code_expired");
        case "access_denied":
          throw codedError("oauth_denied");
        case "device_flow_disabled":
          throw codedError("device_flow_disabled");
        default:
          break;
      }
      // GitHub said no in a way we don't expect: waiting will not change it.
      if (saidNo(result)) throw codedError("token_exchange_failed");
      // No answer (offline, a timeout, a reset), a 5xx or a throttle may pass,
      // so it is asked again at the interval until the code expires: the user
      // may still be typing the code on a phone while this machine's network
      // drops out for a minute.
    }
  }

  return { startDeviceAuthorization, pollForToken };
}

module.exports = {
  createDeviceFlow,
  DEVICE_GRANT_TYPE,
  DEFAULT_INTERVAL_MS,
  DEFAULT_EXPIRES_IN_S,
  SLOW_DOWN_STEP_MS,
};
