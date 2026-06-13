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
  return client.createWebSocket(path, {
    wsOptions: { headers: { Authorization: `Bearer ${apiKey}` } },
  });
}

module.exports = { createTinfoilRealtimeSocket };
