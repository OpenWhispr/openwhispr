// Local read-aloud voices. Each entry is a k2-fsa sherpa-onnx release archive
// that extracts to a directory named after the archive: its id, unless several
// speakers ship in one archive and share it through `archive` (see
// voiceEngine.js for the per-engine file layout).
const RELEASE_BASE = "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models";

// Kokoro 82M v1.0 (Apache 2.0) carries all its speakers in one archive, so
// installing either Kokoro voice installs both.
const KOKORO_ARCHIVE = "kokoro-multi-lang-v1_0";

const VOICES = [
  {
    id: "vits-piper-pt_BR-faber-medium",
    label: "Faber (PT-BR)",
    language: "pt",
    engine: "piper",
    sizeBytes: 67_183_065,
  },
  {
    // Supertonic 3 speaker "Sam" (style M4 in the upstream demo), Brazilian
    // Portuguese at 16 steps: more natural, ~1–2 s to the first word.
    // sherpa-onnx builds voice.bin from the style files sorted by name
    // (F1..F5 = sid 0..4, M1..M5 = sid 5..9), so M4 is sid 8.
    id: "sherpa-onnx-supertonic-3-tts-int8-2026-05-11",
    label: "Sam — natural (PT-BR)",
    language: "pt",
    engine: "supertonic",
    sid: 8,
    numSteps: 16,
    lang: "pt",
    // Supertonic runs four ONNX sessions, each with its own thread pool, so
    // the count multiplies. 2 threads already give ~3x real time (measured:
    // RTF 0.34 at 2 vs 0.30 at 6); 6 saturated all cores and froze the overlay.
    numThreads: 2,
    sizeBytes: 128_774_318,
  },
  {
    // Kokoro speakers pf_dora (sid 42) and pm_alex (sid 43), both Brazilian.
    // Text goes through espeak-ng "pt-br"; the archive's English and Chinese
    // lexicons are left out so Portuguese words never get English sounds.
    // ~2.7x real time on 2 threads (RTF 0.35-0.42 measured on a Ryzen 5700X).
    id: "kokoro-pt_BR-dora",
    archive: KOKORO_ARCHIVE,
    label: "Dora — Kokoro (PT-BR)",
    language: "pt",
    engine: "kokoro",
    sid: 42,
    lang: "pt-br",
    numThreads: 2,
    sizeBytes: 349_906_910,
  },
  {
    id: "kokoro-pt_BR-alex",
    archive: KOKORO_ARCHIVE,
    label: "Alex — Kokoro (PT-BR)",
    language: "pt",
    engine: "kokoro",
    sid: 43,
    lang: "pt-br",
    numThreads: 2,
    sizeBytes: 349_906_910,
  },
  {
    // Same Kokoro archive, American English speakers af_heart (sid 3) and
    // am_michael (sid 16), with the archive's US English lexicon.
    id: "kokoro-en_US-heart",
    archive: KOKORO_ARCHIVE,
    label: "Heart — Kokoro (English)",
    language: "en",
    engine: "kokoro",
    sid: 3,
    lang: "en-us",
    lexicon: "lexicon-us-en.txt",
    numThreads: 2,
    sizeBytes: 349_906_910,
  },
  {
    id: "kokoro-en_US-michael",
    archive: KOKORO_ARCHIVE,
    label: "Michael — Kokoro (English)",
    language: "en",
    engine: "kokoro",
    sid: 16,
    lang: "en-us",
    lexicon: "lexicon-us-en.txt",
    numThreads: 2,
    sizeBytes: 349_906_910,
  },
  {
    id: "vits-piper-pt_BR-dii-high",
    label: "Dii (PT-BR)",
    language: "pt",
    engine: "piper",
    sizeBytes: 67_238_016,
  },
  {
    id: "vits-piper-pt_BR-miro-high",
    label: "Miro (PT-BR)",
    language: "pt",
    engine: "piper",
    sizeBytes: 67_207_707,
  },
  {
    id: "vits-piper-pt_BR-cadu-medium",
    label: "Cadu (PT-BR)",
    language: "pt",
    engine: "piper",
    sizeBytes: 67_207_562,
  },
  {
    id: "vits-piper-pt_BR-jeff-medium",
    label: "Jeff (PT-BR)",
    language: "pt",
    engine: "piper",
    sizeBytes: 67_207_052,
  },
  {
    id: "vits-piper-pt_BR-edresson-low",
    label: "Edresson (PT-BR)",
    language: "pt",
    engine: "piper",
    sizeBytes: 67_081_775,
  },
];

// Default voice per UI language; anything without its own voice yet reads
// in English.
const DEFAULT_VOICES = {
  pt: "vits-piper-pt_BR-faber-medium",
  en: "kokoro-en_US-heart",
};
const DEFAULT_VOICE_ID = DEFAULT_VOICES.en;

function defaultVoiceFor(uiLanguage) {
  const base = String(uiLanguage || "").split("-")[0];
  return DEFAULT_VOICES[base] || DEFAULT_VOICE_ID;
}

function getVoice(id) {
  return VOICES.find((voice) => voice.id === id) || null;
}

// The release archive a voice ships in, which is also its directory name.
function getVoiceArchive(id) {
  const voice = getVoice(id);
  return voice?.archive || id;
}

function getVoiceUrl(id) {
  return `${RELEASE_BASE}/${getVoiceArchive(id)}.tar.bz2`;
}

// Voices that share an archive share files on disk and, once loaded, the
// worker's model: removing or loading one affects the other.
function shareVoiceFiles(a, b) {
  return !!a && !!b && getVoiceArchive(a) === getVoiceArchive(b);
}

module.exports = {
  VOICES,
  DEFAULT_VOICE_ID,
  defaultVoiceFor,
  getVoice,
  getVoiceArchive,
  getVoiceUrl,
  shareVoiceFiles,
};
