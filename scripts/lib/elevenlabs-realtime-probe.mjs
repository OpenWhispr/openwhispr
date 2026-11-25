import ElevenLabsStreaming from "../../src/helpers/elevenLabsStreaming.js";

// connect() resolves only on session_started, and the session then keeps itself
// alive, so cleanup() is what lets the canary process exit.
export async function probeElevenLabsRealtime(key, streaming = new ElevenLabsStreaming()) {
  try {
    await streaming.connect({ apiKey: key, keyterms: ["OpenWhispr"] });
    return { ok: true };
  } finally {
    streaming.cleanup();
  }
}
