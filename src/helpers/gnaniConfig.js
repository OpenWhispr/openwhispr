const GNANI_STT_URL = "https://api.vachana.ai/stt/v3";
const GNANI_LANGUAGES = new Set(["bn", "en", "gu", "hi", "kn", "ml", "mr", "pa", "ta", "te"]);

// WebSocket headers must be ASCII. Escape UTF-16 code units, including both
// halves of supplementary characters, so a JSON parser recovers the original.
function asciiJson(value) {
  return JSON.stringify(value).replace(
    /[^\x20-\x7e]/g,
    (char) => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0")
  );
}

function normalizeKeyterms(words) {
  const terms = new Set();
  let encodedSize = 2; // enclosing JSON array
  for (const word of Array.isArray(words) ? words : []) {
    const term = typeof word === "string" ? word.trim() : "";
    if (!term || terms.has(term) || term.includes("<|") || term.includes("|>")) continue;
    const size = asciiJson(term).length + (terms.size ? 1 : 0);
    if (encodedSize + size > 4096) continue;
    terms.add(term);
    encodedSize += size;
    if (terms.size === 200) break;
  }
  return [...terms];
}

function resolveGnaniConfig({ model, language, keyterms } = {}) {
  const selected = model === "prisma-v2.5" ? model : "prisma-v3.0";
  const base = language?.toLowerCase().split(/[-_]/)[0];
  const supported = GNANI_LANGUAGES.has(base);
  if (selected === "prisma-v2.5" && base && !supported && base !== "auto") {
    throw new Error(
      "Choose a supported Indian language or English for Prisma v2.5 in Speech to Text settings."
    );
  }
  // Keep the same language when dictation falls back to REST. v2.5 REST
  // needs a single language, so Auto selects Indian English for that model.
  return {
    model: selected,
    languageCode: supported ? base + "-IN" : selected === "prisma-v2.5" ? "en-IN" : "indic-auto",
    format: selected === "prisma-v2.5" ? "transcribe" : "codemix",
    keyterms: selected === "prisma-v2.5" ? [] : normalizeKeyterms(keyterms),
  };
}

module.exports = { GNANI_STT_URL, asciiJson, resolveGnaniConfig };
