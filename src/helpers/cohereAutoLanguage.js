const { resolveModelLanguage } = require("./parakeetModelInfo");

// The model Cohere Transcribe ships as. resolveModelLanguage maps Auto to
// English for every cohere-transcribe model; this id is the one Settings and
// meetings use when the user has not picked another.
const COHERE_TRANSCRIBE_MODEL = "cohere-transcribe-03-2026";

// Null when this provider can detect the language. Cohere cannot, so Auto is
// English — the same fallback the sherpa server is started with.
function implicitAutoLanguage(provider) {
  if (provider !== "cohere") return null;
  return resolveModelLanguage(COHERE_TRANSCRIBE_MODEL, "auto");
}

function firstImplicitAutoLanguage(scopes) {
  for (const scope of scopes || []) {
    if (!scope || scope.mode !== "local") continue;
    const language = implicitAutoLanguage(scope.provider);
    if (language) return language;
  }
  return null;
}

module.exports = {
  firstImplicitAutoLanguage,
  implicitAutoLanguage,
};
