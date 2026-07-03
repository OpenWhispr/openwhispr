// WebSocket access to Tinfoil's realtime transcription endpoint. The SDK's
// SecureClient attests the enclave and pins the socket's TLS connection to the
// attested key; one client is held per session so attestation is paid once.
let clientPromise = null;

function getSecureClient() {
  if (!clientPromise) {
    // ESM-only package, loaded from CommonJS.
    clientPromise = import("tinfoil").then(({ SecureClient }) => new SecureClient());
    // Don't cache a failed import — the next dictation should retry.
    clientPromise.catch(() => {
      clientPromise = null;
    });
  }
  return clientPromise;
}

async function createTinfoilRealtimeSocket({ model, apiKey }) {
  const client = await getSecureClient();
  const path = `/v1/realtime?model=${encodeURIComponent(model)}&intent=transcription`;
  return client.createWebSocket(path, {
    wsOptions: { headers: { Authorization: `Bearer ${apiKey}` } },
  });
}

module.exports = { createTinfoilRealtimeSocket };
