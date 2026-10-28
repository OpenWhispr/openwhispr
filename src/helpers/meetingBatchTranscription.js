// Transcribes one buffered meeting WAV chunk by POSTing it to an
// OpenAI-compatible batch endpoint (Note Recording → Cloud Providers → Custom).
// Pure: no electron imports. The caller injects the fetch implementation
// (Electron's proxyFetch in the main process, a fake in tests) and the resolved
// key — routes never carry secrets, and the renderer never sees the key.
//
// Custom endpoints have no realtime websocket, so Note Recording runs them on
// the local chunk pipeline (5 s PCM buffers, RMS gate, holdback/dedup) and
// swaps the whisper.cpp/sherpa call for this request.

function buildAuthHeaders({ apiKey, authScheme }) {
  const key = typeof apiKey === "string" ? apiKey.trim() : "";
  if (!key) return {};
  // Azure authenticates with the `api-key` header; Bearer is reserved for Entra ID.
  if (authScheme === "azure-api-key") return { "api-key": key };
  return { Authorization: `Bearer ${key}` };
}

async function transcribeMeetingChunkBatch({
  endpoint,
  model,
  language,
  wav,
  apiKey,
  authScheme = "bearer",
  fetchImpl,
}) {
  const formData = new FormData();
  formData.append("file", new Blob([wav], { type: "audio/wav" }), "chunk.wav");
  if (model) {
    formData.append("model", model);
  }
  if (language) {
    formData.append("language", language);
  }

  // Content-Type is left to fetch so FormData can set the multipart boundary.
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: buildAuthHeaders({ apiKey, authScheme }),
    body: formData,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Custom transcription API error: ${response.status} ${errorText}`);
  }

  const data = await response.json();
  return { success: true, text: data?.text ?? "" };
}

module.exports = { transcribeMeetingChunkBatch, buildAuthHeaders };
