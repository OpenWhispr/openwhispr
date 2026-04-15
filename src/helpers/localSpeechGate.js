const SILENCE_RMS_THRESHOLD = 0.002;
const SPEECH_WINDOW_RMS_THRESHOLD = 0.0045;
const SPEECH_WINDOW_PEAK_THRESHOLD = 0.04;
const STRONG_SPEECH_RMS_THRESHOLD = 0.008;
const MIN_SPEECH_WINDOWS = 2;
const MIN_CONSECUTIVE_SPEECH_WINDOWS = 2;

export const createLocalSpeechGateState = () => ({
  peakRms: 0,
  peakAmplitude: 0,
  windowCount: 0,
  speechWindowCount: 0,
  consecutiveSpeechWindows: 0,
  maxConsecutiveSpeechWindows: 0,
});

export const recordLocalSpeechWindow = (state, rms, peak) => {
  if (!state) {
    return null;
  }

  state.windowCount += 1;
  state.peakRms = Math.max(state.peakRms, rms);
  state.peakAmplitude = Math.max(state.peakAmplitude, peak);

  const isSpeechWindow = rms >= SPEECH_WINDOW_RMS_THRESHOLD && peak >= SPEECH_WINDOW_PEAK_THRESHOLD;
  if (!isSpeechWindow) {
    state.consecutiveSpeechWindows = 0;
    return state;
  }

  state.speechWindowCount += 1;
  state.consecutiveSpeechWindows += 1;
  state.maxConsecutiveSpeechWindows = Math.max(
    state.maxConsecutiveSpeechWindows,
    state.consecutiveSpeechWindows
  );
  return state;
};

export const getLocalSpeechGateDecision = (state) => {
  if (!state?.windowCount) {
    return { skip: false, reason: "unavailable" };
  }

  const metrics = {
    peakRms: state.peakRms,
    peakAmplitude: state.peakAmplitude,
    windowCount: state.windowCount,
    speechWindowCount: state.speechWindowCount,
    maxConsecutiveSpeechWindows: state.maxConsecutiveSpeechWindows,
  };

  if (state.peakRms < SILENCE_RMS_THRESHOLD) {
    return { skip: true, reason: "silence", ...metrics };
  }

  const hasSpeech =
    state.speechWindowCount >= MIN_SPEECH_WINDOWS ||
    state.maxConsecutiveSpeechWindows >= MIN_CONSECUTIVE_SPEECH_WINDOWS ||
    (state.speechWindowCount >= 1 && state.peakRms >= STRONG_SPEECH_RMS_THRESHOLD);

  if (!hasSpeech) {
    return { skip: true, reason: "insufficient_speech", ...metrics };
  }

  return { skip: false, reason: "speech_detected", ...metrics };
};
