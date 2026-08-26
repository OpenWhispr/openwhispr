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
  if (!isRecord(value) || typeof value.exists !== "boolean") {
    throw new Error(INVALID_DISCOVERY_RESPONSE);
  }

  if (value.sso === undefined) {
    return { exists: value.exists };
  }

  const sso = value.sso;
  if (
    !isRecord(sso) ||
    typeof sso.available !== "boolean" ||
    typeof sso.required !== "boolean" ||
    (sso.domain !== undefined && typeof sso.domain !== "string")
  ) {
    throw new Error(INVALID_DISCOVERY_RESPONSE);
  }

  const domain = typeof sso.domain === "string" ? sso.domain : undefined;

  return {
    exists: value.exists,
    sso: {
      available: sso.available,
      required: sso.required,
      ...(domain === undefined ? {} : { domain }),
    },
  };
}

export async function discoverEmailAuth(
  email: string,
  authUrl: string
): Promise<EmailAuthDiscovery> {
  const response = await fetch(`${authUrl}/api/check-user`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: email.trim() }),
  });

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
