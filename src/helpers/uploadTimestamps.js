// Which extra multipart fields ask a BYOK transcription provider for
// segment-level timestamps, and how its verbose response maps back to
// segments. Gated per provider/model because unsupported combinations
// (gpt-4o-transcribe rejects verbose_json; custom/self-hosted servers may
// 400 on unknown fields) must keep the plain-text request untouched — a
// missing timestamp is a degraded export, never a failed upload.
function timestampRequestFields(provider, model) {
  if (provider === "openai" && model === "whisper-1") {
    return { response_format: "verbose_json" };
  }
  if (provider === "groq") {
    return { response_format: "verbose_json" };
  }
  if (provider === "mistral") {
    return { timestamp_granularities: "segment" };
  }
  return null;
}

// verbose_json (OpenAI/Groq) and Mistral's segment granularity both carry
// `segments: [{ text, start, end }]`. Null when the response has nothing
// usable, so callers fall back to the plain transcript.
function mapVerboseSegments(responseData) {
  const segments = responseData?.segments;
  if (!Array.isArray(segments)) return null;

  const mapped = [];
  for (const seg of segments) {
    const text = typeof seg?.text === "string" ? seg.text.trim() : "";
    if (!text || !Number.isFinite(seg.start)) continue;
    const start = Math.max(0, seg.start);
    const rawEnd = Number.isFinite(seg.end) ? seg.end : start;
    const end = Math.max(start, rawEnd);
    mapped.push({
      text,
      start,
      end,
    });
  }
  return mapped.length ? mapped : null;
}

// whisper.cpp's CLI JSON stores offsets in milliseconds under `transcription`.
// The server `verbose_json` shape is the same `segments` array mapVerboseSegments
// already reads. Null when the engine returned text only.
function mapWhisperSegments(result) {
  const verbose = mapVerboseSegments(result);
  if (verbose) return verbose;

  const rows = result?.transcription;
  if (!Array.isArray(rows)) return null;

  const mapped = [];
  for (const seg of rows) {
    const text = typeof seg?.text === "string" ? seg.text.trim() : "";
    const fromMs = seg?.offsets?.from;
    if (!text || !Number.isFinite(fromMs)) continue;
    const start = Math.max(0, fromMs) / 1000;
    const toMs = Number.isFinite(seg?.offsets?.to) ? seg.offsets.to : fromMs;
    const end = Math.max(start, Math.max(0, toMs) / 1000);
    mapped.push({ text, start, end });
  }
  return mapped.length ? mapped : null;
}

module.exports = { timestampRequestFields, mapVerboseSegments, mapWhisperSegments };
