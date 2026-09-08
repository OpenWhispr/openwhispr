const { net } = require("electron");
const { createHash } = require("crypto");

const CORTI_ENVIRONMENTS = new Set(["eu", "us"]);
const TENANT_PATTERN = /^[a-zA-Z0-9_-]+$/;
// Corti access tokens live 5 minutes; refresh early so in-flight requests never race expiry.
const TOKEN_REFRESH_MARGIN_MS = 30_000;
// Matches the per-endpoint cap in providerConnectionTest.js, so a stalled
// auth server fails the connection test instead of hanging it.
const TOKEN_FETCH_TIMEOUT_MS = 12_000;

const tokenCache = new Map();

function assertValidTarget(environment, tenant) {
  if (!CORTI_ENVIRONMENTS.has(environment)) {
    throw new Error(`Invalid Corti environment: ${environment}`);
  }
  if (!TENANT_PATTERN.test(tenant)) {
    throw new Error("Invalid Corti tenant name");
  }
}

async function getCortiToken({ environment, tenant, clientId, clientSecret }, fetchImpl) {
  assertValidTarget(environment, tenant);

  // The secret is part of the key (digested, never stored raw) so edited
  // credentials always re-authenticate; a key without it makes a connection
  // test pass on a cached token minted by the previous, different secret.
  const secretDigest = createHash("sha256")
    .update(clientSecret ?? "")
    .digest("hex")
    .slice(0, 16);
  const cacheKey = `${environment}/${tenant}/${clientId}/${secretDigest}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.value;
  }

  const doFetch = fetchImpl || ((url, init) => net.fetch(url, init));
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), TOKEN_FETCH_TIMEOUT_MS);
  try {
    const response = await doFetch(
      `https://auth.${environment}.corti.app/realms/${tenant}/protocol/openid-connect/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: clientId,
          client_secret: clientSecret,
          scope: "openid",
        }).toString(),
        signal: controller.signal,
      }
    );

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(`Corti authentication failed: ${response.status} ${errorText}`.trim());
    }

    const data = await response.json();
    if (!data.access_token) {
      throw new Error("Corti authentication failed: no access token in response");
    }

    tokenCache.set(cacheKey, {
      value: data.access_token,
      expiresAt: Date.now() + (data.expires_in || 300) * 1000 - TOKEN_REFRESH_MARGIN_MS,
    });
    return data.access_token;
  } finally {
    clearTimeout(timeoutHandle);
  }
}

module.exports = { assertValidTarget, getCortiToken };
