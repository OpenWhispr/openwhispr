const { net } = require("electron");

const CORTI_ENVIRONMENTS = new Set(["eu", "us"]);
const TENANT_PATTERN = /^[a-zA-Z0-9_-]+$/;
// Corti access tokens live 5 minutes; refresh early so in-flight requests never race expiry.
const TOKEN_REFRESH_MARGIN_MS = 30_000;

const tokenCache = new Map();

function assertValidTarget(environment, tenant) {
  if (!CORTI_ENVIRONMENTS.has(environment)) {
    throw new Error(`Invalid Corti environment: ${environment}`);
  }
  if (!TENANT_PATTERN.test(tenant)) {
    throw new Error("Invalid Corti tenant name");
  }
}

async function getCortiToken({ environment, tenant, clientId, clientSecret }) {
  assertValidTarget(environment, tenant);

  const cacheKey = `${environment}/${tenant}/${clientId}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.value;
  }

  const response = await net.fetch(
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
}

module.exports = { assertValidTarget, getCortiToken };
