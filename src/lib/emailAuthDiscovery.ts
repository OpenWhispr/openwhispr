export interface EmailAuthDiscovery {
  exists: boolean;
  sso?: {
    available: boolean;
    required: boolean;
    domain?: string;
  };
}

const INVALID_DISCOVERY_RESPONSE = "Email account discovery returned an invalid response";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseEmailAuthDiscovery(value: unknown): EmailAuthDiscovery {
  // Only `exists` is load-bearing (it routes between sign-in and sign-up), so
  // only it is validated strictly. The sso block is advisory: a missing or
  // malformed one falls back to the plain email flow instead of blocking auth.
  if (!isRecord(value) || typeof value.exists !== "boolean") {
    throw new Error(INVALID_DISCOVERY_RESPONSE);
  }

  const sso = value.sso;
  if (!isRecord(sso) || sso.available !== true) {
    return { exists: value.exists };
  }

  return {
    exists: value.exists,
    sso: {
      available: true,
      required: sso.required === true,
      ...(typeof sso.domain === "string" ? { domain: sso.domain } : {}),
    },
  };
}

export async function discoverEmailAuth(
  email: string,
  authUrl: string
): Promise<EmailAuthDiscovery | null> {
  const response = await fetch(`${authUrl}/api/check-user`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: email.trim() }),
  });

  // A self-hosted auth server may not implement /api/check-user; report that
  // as "discovery unavailable" so the caller can fall back instead of erroring.
  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`Email account discovery failed with status ${response.status}`);
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new Error(INVALID_DISCOVERY_RESPONSE);
  }

  return parseEmailAuthDiscovery(data);
}
