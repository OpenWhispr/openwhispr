// Verified-WebSocket access to Tinfoil's realtime transcription endpoint.
// The tinfoil SDK's SecureClient attests the enclave (code measurement vs
// runtime attestation via the transparency log) and pins the realtime
// WebSocket's TLS connection to the attested key.
//
// One SecureClient is held for the session: the SDK memoizes attestation
// internally, so only the first dictation pays the verification round-trip
// and the rest reuse the verified enclave.
let clientPromise = null;

function getSecureClient() {
  if (!clientPromise) {
    // ESM-only package, loaded from CommonJS.
    clientPromise = import("tinfoil").then(({ SecureClient }) => new SecureClient());
  }
  return clientPromise;
}

// Opens a realtime WebSocket to the verified enclave. createWebSocket attests
// on first use, resolves the path against the enclave URL, pins the TLS
// connection to the attested key, and refuses to send the auth header to any
// host other than that enclave.
async function createTinfoilRealtimeSocket({ model, apiKey }) {
  const client = await getSecureClient();
  const path = `/v1/realtime?model=${encodeURIComponent(model)}&intent=transcription`;
  const socket = await client.createWebSocket(path, {
    wsOptions: { headers: { Authorization: `Bearer ${apiKey}` } },
  });

  // The SDK pins the WebSocket to the TLS key attested when the client was first
  // built and never re-attests on the WS path, so when the enclave rotates its
  // cert the pin goes stale. Drop the cached client on a pinning failure so the
  // next attempt re-attests.
  // TODO: tinfoil-js should recover WS pin failures itself: remove this when
  // a newer tinfoil release ships that fix.
  socket.once("error", (err) => {
    if (String(err?.message).includes("TLS pinning failed")) {
      clientPromise = null;
    }
  });

  return socket;
}

module.exports = { createTinfoilRealtimeSocket };
