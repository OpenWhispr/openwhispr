// Web search for fork builds: one POST to our own services host with the
// Titanium license key as bearer. Pure (no Electron import) so the request and
// the error mapping are unit-tested. The key stays in the main process; the
// renderer gets results or a code. Mode selection, not an error fallback:
// this module never retries and never tries a second URL.

const SEARCH_PATH = "/v1/agent/web-search";

const failure = (code, error) => ({ success: false, code, error });

// The stt-api answers errors as { error: { code, message } }.
async function readServerMessage(response) {
  try {
    const body = await response.json();
    const message = body?.error?.message;
    return typeof message === "string" ? message.slice(0, 200) : "";
  } catch {
    return "";
  }
}

async function forkWebSearch({ servicesUrl, getKey, fetchImpl }, query, numResults = 5) {
  const base = String(servicesUrl || "").replace(/\/+$/, "");
  if (!base) return failure("SERVER_ERROR", "Web search service is not configured");

  // The bearer is a credential: never send it over anything but https.
  let parsed;
  try {
    parsed = new URL(base);
  } catch {
    return failure("SERVER_ERROR", "Web search service is not configured");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    return failure("SERVER_ERROR", "Web search service must use https");
  }

  const url = `${base}${SEARCH_PATH}`;
  const key = getKey(url);
  if (!key) return failure("AUTH_REQUIRED", "Sign in to use web search");

  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ query, numResults }),
    });
  } catch {
    return failure("SERVER_ERROR", "Web search is unavailable");
  }

  if (!response.ok) {
    const status = response.status;
    if (status === 401 || status === 403) return failure("AUTH_EXPIRED", "Session expired");
    if (status === 429) return failure("RATE_LIMITED", "Too many searches, try again shortly");
    const detail = await readServerMessage(response);
    if (status >= 500) return failure("SERVER_ERROR", detail || "Web search is unavailable");
    return failure("REQUEST_REJECTED", detail || `Web search rejected the request (${status})`);
  }

  let data;
  try {
    data = await response.json();
  } catch {
    return failure("SERVER_ERROR", "Web search returned an unreadable response");
  }
  const results = Array.isArray(data?.results) ? data.results : [];
  return { success: true, results };
}

module.exports = { forkWebSearch, SEARCH_PATH };
