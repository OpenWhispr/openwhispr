"use strict";

// Backend only. Call AFTER your existing user, entitlement and rate-limit checks.
// Never import this module or its service key into the desktop distribution.
const BASE_URL = "https://orukeet.gizmovoice.ai";

async function issueSession({
  serviceKey,
  accountId,
  socketRole = "warm",
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof serviceKey !== "string" || !serviceKey.trim()) {
    throw new Error("ORUKEET_SERVICE_KEY is required on the backend");
  }
  // Derive this opaque ID from the authenticated backend user, never desktop input.
  if (
    accountId !== undefined &&
    (typeof accountId !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(accountId))
  ) {
    throw new Error("accountId must be an opaque 8–128 character identifier");
  }
  if (!["warm", "active"].includes(socketRole)) {
    throw new Error("socketRole must be warm or active");
  }
  let response;
  try {
    response = await fetchImpl(`${BASE_URL}/v1/client-token`, {
      method: "POST",
      headers: { Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(
        accountId === undefined ? {} : { account_id: accountId, socket_role: socketRole }
      ),
      signal: AbortSignal.timeout(10000),
      redirect: "error",
      cache: "no-store",
    });
  } catch {
    throw new Error("Orukeet session service is unavailable");
  }
  if (!response.ok) {
    // Do not propagate upstream response bodies, request headers or tokens.
    throw new Error(`Orukeet session request failed (HTTP ${response.status})`);
  }
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error("Invalid Orukeet session response");
  }
  if (
    typeof data?.token !== "string" ||
    !/^[A-Za-z0-9._-]{1,96}$/.test(data.token) ||
    data.single_use !== true ||
    data.expires_in !== 60 ||
    data.protocol !== "orukeet.pcm.v1" ||
    (accountId !== undefined && data.account_limits !== true)
  ) {
    throw new Error("Invalid Orukeet session response");
  }
  return {
    baseUrl: BASE_URL,
    websocketUrl: "wss://orukeet.gizmovoice.ai/v1/audio/transcriptions/stream",
    clientToken: data.token,
    protocol: data.protocol,
    expiresIn: data.expires_in,
    singleUse: true,
    model: "orukeet-v0.1.0",
  };
}

module.exports = { issueSession, BASE_URL };
