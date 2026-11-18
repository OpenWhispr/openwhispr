const { readJson, formBody } = require("./providerHttp");
const { classifyHttpStatus, classifyTransportError } = require("./deliveryClassifier");

// Pin the documented Spring '26 API instead of changing behavior with each org upgrade.
const SALESFORCE_API_VERSION = "v66.0";
const SALESFORCE_API_BASE = `/services/data/${SALESFORCE_API_VERSION}`;
const SALESFORCE_LOGIN_URL = "https://login.salesforce.com";
const USERINFO_PATH = "/services/oauth2/userinfo";
const REQUEST_TIMEOUT_MS = 15000;

function normalizeSalesforceOrigin(value, { login = false } = {}) {
  if (typeof value !== "string" || !/^https:\/\/[a-z0-9.-]+\/?$/i.test(value)) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const myDomain =
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.(?:(?:sandbox|develop|scratch|demo|trailblaze)\.)?my\.salesforce\.com$/;
  if (
    !myDomain.test(url.hostname) &&
    !(login && ["login.salesforce.com", "test.salesforce.com"].includes(url.hostname))
  )
    return null;
  return url.origin;
}

function validPath(path) {
  if (typeof path !== "string" || /[\\#\s]/.test(path)) return false;
  if (path === USERINFO_PATH) return true;
  if (!path.startsWith(`${SALESFORCE_API_BASE}/`)) return false;
  const pathname = path.split("?")[0];
  return (
    !pathname.includes("%") &&
    !pathname.split("/").some((segment) => segment === "." || segment === "..")
  );
}

function failure(errorCode, outcome = "failed") {
  return { ok: false, errorCode, outcome };
}

function createSalesforceApi({ fetchImpl }) {
  async function send(url, init, { emptySuccess = false } = {}) {
    let response;
    try {
      response = await fetchImpl(url, {
        ...init,
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      // Electron's net.fetch rejects a real redirect instead of returning the 3xx.
      if (error?.message === "Redirect was cancelled")
        return failure("redirect_refused", "unknown");
      // Salesforce's own codes are upper case too (ENTITY_IS_LOCKED), so a
      // transport code (ECONNRESET) would read as one of them.
      return failure("network", classifyTransportError(error));
    }
    if (response.status >= 300 && response.status < 400)
      return failure("redirect_refused", "unknown");
    const data = await readJson(response);
    if (response.ok) {
      if (data !== null || response.status === 204 || emptySuccess) return { ok: true, data };
      return failure("bad_response", "unknown");
    }
    const code = Array.isArray(data) ? data[0]?.errorCode : data?.error;
    return {
      ...failure(
        typeof code === "string" && /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(code)
          ? code
          : `http_${response.status}`,
        classifyHttpStatus(response.status)
      ),
      status: response.status,
      refused: response.status >= 400 && response.status < 500,
    };
  }

  function request({ instanceUrl, accessToken, method = "GET", path, body, headers = {} }) {
    // UserInfo is the only bearer endpoint permitted on the standard login hosts.
    const origin = normalizeSalesforceOrigin(instanceUrl, { login: path === USERINFO_PATH });
    if (!origin || !validPath(path)) return Promise.resolve(failure("invalid_destination"));
    if (!["GET", "POST", "PATCH"].includes(method) || (path === USERINFO_PATH && method !== "GET"))
      return Promise.resolve(failure("invalid_method"));
    if (typeof accessToken !== "string" || !accessToken || /[\r\n]/.test(accessToken))
      return Promise.resolve(failure("unauthorized"));
    const conditionalHeaders = {};
    for (const [name, value] of Object.entries(headers)) {
      if (
        name.toLowerCase() !== "if-unmodified-since" ||
        typeof value !== "string" ||
        /[\r\n]/.test(value)
      )
        return Promise.resolve(failure("invalid_headers"));
      conditionalHeaders["If-Unmodified-Since"] = value;
    }
    return send(`${origin}${path}`, {
      method,
      headers: {
        ...conditionalHeaders,
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  function oauthRequest(params, loginUrl, endpoint, emptySuccess = false) {
    const origin = normalizeSalesforceOrigin(loginUrl ?? SALESFORCE_LOGIN_URL, { login: true });
    if (!origin) return Promise.resolve(failure("invalid_destination"));
    return send(
      `${origin}/services/oauth2/${endpoint}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: formBody(params),
      },
      { emptySuccess }
    );
  }

  return {
    request,
    exchangeToken: (params, loginUrl) => oauthRequest(params, loginUrl, "token"),
    refreshToken: (params, loginUrl) =>
      oauthRequest({ ...params, grant_type: "refresh_token" }, loginUrl, "token"),
    revokeToken: (token, loginUrl) => oauthRequest({ token }, loginUrl, "revoke", true),
  };
}

module.exports = {
  createSalesforceApi,
  normalizeSalesforceOrigin,
  SALESFORCE_API_BASE,
  SALESFORCE_LOGIN_URL,
  USERINFO_PATH,
};
