import elevenLabsTranscription from "../../src/helpers/elevenLabsTranscription.js";

const { transcribeWithElevenLabs } = elevenLabsTranscription;

export async function probeElevenLabsBatch(key, audio, fetchImpl = fetch) {
  if (!audio) return { ok: false, detail: "could not build audio/webm fixture" };
  const keyterm = "OpenWhispr";
  const { acceptedKeyterms } = await transcribeWithElevenLabs(
    { audioBuffer: audio, contentType: "audio/webm", keyterms: [keyterm], apiKey: key },
    fetchImpl
  );
  // Silence can produce an empty transcript even when the keyterm was accepted.
  return acceptedKeyterms.includes(keyterm)
    ? { ok: true }
    : { ok: false, detail: "ElevenLabs rejected the dictation keyterm" };
}
