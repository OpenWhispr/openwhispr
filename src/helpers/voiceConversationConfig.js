const VAD_SAMPLE_RATE = 16000;
const SMART_TURN_PAUSE_MS = 200;
const SMART_TURN_MAX_SILENCE_MS = 1200;
const SMART_TURN_MAX_TURN_MS = 30000;
// Supertonic voice F2 at 5 flow steps. Fewer steps sounded distorted, and each extra
// step adds ~85 ms per sentence. Two threads were the fastest for this int8 build.
const SUPERTONIC_VOICE_SID = 1;
const SUPERTONIC_NUM_STEPS = 5;
const TTS_NUM_THREADS = 2;

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
    ttsGeneration: {
      sid: SUPERTONIC_VOICE_SID,
      numSteps: SUPERTONIC_NUM_STEPS,
      extra: { lang: "en" },
    },
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

// English-first: a voice turn is short, so the fastest downloaded model wins.
const PARAKEET_FALLBACK_ORDER = [
  "parakeet-unified-en-0.6b",
  "parakeet-tdt-0.6b-v3",
  "nemotron-speech-streaming-en-0.6b",
  "nemotron-3.5-asr-streaming-0.6b",
];

/**
 * The settings' Parakeet model may not be downloaded (e.g. cloud transcription
 * users), so voice conversation uses the first downloaded candidate instead.
 */
function resolveVoiceParakeetModel(requested, isDownloaded) {
  if (requested && isDownloaded(requested)) return requested;
  return PARAKEET_FALLBACK_ORDER.find((name) => isDownloaded(name)) || requested;
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
  buildVoiceWorkerConfig,
  resolveVoiceParakeetModel,
  float32ToPcm16Buffer,
};
