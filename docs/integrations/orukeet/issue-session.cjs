"use strict";

// Backend only. Call AFTER your existing user, entitlement and rate-limit checks.
// Never import this module or its service key into the desktop distribution.
const BASE_URL = "https://orukeet.gizmovoice.ai";

async function issueSession({ serviceKey, fetchImpl = globalThis.fetch } = {}) {
  if (typeof serviceKey !== "string" || !serviceKey.trim()) {
    throw new Error("ORUKEET_SERVICE_KEY is required on the backend");
  }
  let response;
  try {
    response = await fetchImpl(`${BASE_URL}/v1/client-token`, {
      method: "POST",
      headers: { Authorization: `Bearer ${serviceKey}` },
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
    data.protocol !== "orukeet.pcm.v1"
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
