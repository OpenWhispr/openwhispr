const VAD_SAMPLE_RATE = 16000;
const SMART_TURN_PAUSE_MS = 200;
const SMART_TURN_MAX_SILENCE_MS = 1200;
const SMART_TURN_MAX_TURN_MS = 30000;
// Fewer than 5 flow steps sounded distorted, and each extra step adds ~85 ms per
// sentence. Two threads were the fastest for this int8 build.
const SUPERTONIC_NUM_STEPS = 5;
const TTS_NUM_THREADS = 2;

// The call's voices by setting id, mapped to Supertonic 3 speakers: its voice.bin holds
// F1–F5 as speakers 0–4 and M1–M5 as 5–9 (checked by pitch: 0–4 sit at 160–205 Hz,
// 5–9 at 80–130 Hz). Helios is M1, Aurora is F2. Shared with the renderer's settings.
const {
  voices: VOICE_SPEAKER_IDS,
  defaultVoice: DEFAULT_VOICE,
  speed: SPEECH_RATE,
  languages: CALL_LANGUAGES,
} = require("../config/voiceCall.json");
// Supertonic reads these; an answer in any other language is read as English.
const SPEECH_LANGUAGES = new Set(CALL_LANGUAGES.filter((language) => language !== "auto"));

/**
 * Silero cuts at a short pause and Smart Turn decides whether the turn is over;
 * max silence commits the turn when the classifier keeps saying no. Background
 * speech (a TV, people nearby) can keep every gap under max silence, so max turn
 * commits at the next pause rather than growing one turn without bound.
 */
function buildVoiceWorkerConfig({ modelPaths }) {
  return {
    smartTurn: {
      model: modelPaths.smartTurn,
      maxSilenceMs: SMART_TURN_MAX_SILENCE_MS,
      maxTurnMs: SMART_TURN_MAX_TURN_MS,
      // Pipecat uses 0.5; offline, 0.8 kept the same turn-end speed with fewer mid-sentence cuts.
      threshold: 0.8,
      numThreads: 4,
    },
    tts: {
      model: {
        supertonic: modelPaths.supertonic,
        numThreads: TTS_NUM_THREADS,
        provider: "cpu",
      },
      maxNumSentences: 1,
    },
    numSteps: SUPERTONIC_NUM_STEPS,
    vad: {
      sileroVad: {
        model: modelPaths.vad,
        threshold: 0.5,
        minSilenceDuration: SMART_TURN_PAUSE_MS / 1000,
        minSpeechDuration: 0.25,
        maxSpeechDuration: 20,
        windowSize: 512,
      },
      sampleRate: VAD_SAMPLE_RATE,
      numThreads: 1,
      provider: "cpu",
      debug: false,
    },
  };
}

/**
 * The voice, rate and language one utterance is spoken with, from the renderer's
 * request. Every chunk of an utterance carries the same profile, so a settings
 * change never splices two voices or rates into one answer.
 */
function toSpeechProfile({ voice, speed, language } = {}) {
  const rate = Number(speed);
  const steps = Number.isFinite(rate) ? Math.round(rate / SPEECH_RATE.step) * SPEECH_RATE.step : 1;
  return {
    sid: VOICE_SPEAKER_IDS[voice] ?? VOICE_SPEAKER_IDS[DEFAULT_VOICE],
    speed: Math.min(SPEECH_RATE.max, Math.max(SPEECH_RATE.min, steps)),
    lang: SPEECH_LANGUAGES.has(language) ? language : "en",
  };
}

const speechProfileKey = ({ sid, speed, lang }) => `${sid}:${speed}:${lang}`;

/**
 * The local model that transcribes a call's turns: a downloaded Parakeet-family
 * model that knows the language (the one dictation runs first, so the shared
 * sherpa-onnx server isn't swapped), else a downloaded Whisper model for a
 * language no Parakeet model here knows. Auto needs a model that detects the
 * language itself, which Cohere can't. Null when nothing downloaded fits.
 */
function resolveCallRecognizer(
  language,
  { parakeetModels, preferredParakeet, isParakeetDownloaded, whisperModels, isWhisperDownloaded }
) {
  const fits = (model) =>
    language === "auto"
      ? model.modelType !== "cohere-transcribe"
      : (model.supportedLanguages ?? []).includes(language);
  const parakeet = [
    ...parakeetModels.filter((model) => model.id === preferredParakeet),
    ...parakeetModels,
  ].find((model) => fits(model) && isParakeetDownloaded(model.id));
  if (parakeet) {
    return {
      engine: "parakeet",
      model: parakeet.id,
      // Cohere starts its server for one language; the others detect it.
      language: parakeet.modelType === "cohere-transcribe" ? language : undefined,
    };
  }
  if (language === "auto") return null;
  const whisper = whisperModels.find((model) => isWhisperDownloaded(model));
  return whisper ? { engine: "whisper", model: whisper, language } : null;
}

function float32ToPcm16Buffer(samples) {
  const buffer = Buffer.alloc(samples.length * 2);
  for (let index = 0; index < samples.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[index]));
    buffer.writeInt16LE(
      clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767),
      index * 2
    );
  }
  return buffer;
}

module.exports = {
  VAD_SAMPLE_RATE,
  CALL_LANGUAGES,
  buildVoiceWorkerConfig,
  toSpeechProfile,
  speechProfileKey,
  resolveCallRecognizer,
  float32ToPcm16Buffer,
};
