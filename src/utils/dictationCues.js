import logger from "./logger";
import { getSettings } from "../stores/settingsStore";

const START_NOTES = [523.25, 659.25];
const STOP_NOTES = [587.33, 440];
const DICTATION_TONE = { type: "sine", duration: 0.09, gap: 0.025, gain: 0.2 };
// A voice call opens on a low fifth rising (A3 to E4) and closes on it falling: deeper,
// longer and softer than dictation's blips. Triangle carries the low notes on laptop speakers.
const CALL_START_NOTES = [220, 329.63];
const CALL_END_NOTES = [329.63, 220];
const CALL_TONE = { type: "triangle", duration: 0.22, gap: 0.04, gain: 0.14 };
const NOTE_ATTACK_SECONDS = 0.015;
const MIN_GAIN = 0.0001;

let audioContext = null;

const getAudioContext = () => {
  if (typeof window === "undefined") {
    return null;
  }

  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextCtor) {
    return null;
  }

  if (!audioContext || audioContext.state === "closed") {
    audioContext = new AudioContextCtor();
  }

  return audioContext;
};

export const resumeContextIfNeeded = async () => {
  try {
    const context = getAudioContext();
    if (!context) {
      return null;
    }

    if (context.state === "suspended") {
      await context.resume();
    }

    return context.state === "running" ? context : null;
  } catch (error) {
    logger.debug(
      "Failed to initialize dictation cue audio context",
      { error: error instanceof Error ? error.message : String(error) },
      "audio"
    );
    return null;
  }
};

const scheduleTone = (context, frequency, startTime, tone) => {
  const oscillator = context.createOscillator();
  const gainNode = context.createGain();
  const stopTime = startTime + tone.duration;

  oscillator.type = tone.type;
  oscillator.frequency.setValueAtTime(frequency, startTime);

  gainNode.gain.setValueAtTime(MIN_GAIN, startTime);
  gainNode.gain.linearRampToValueAtTime(tone.gain, startTime + NOTE_ATTACK_SECONDS);
  gainNode.gain.exponentialRampToValueAtTime(MIN_GAIN, stopTime);

  oscillator.connect(gainNode);
  gainNode.connect(context.destination);

  oscillator.start(startTime);
  oscillator.stop(stopTime + 0.01);
};

const isEnabled = () => getSettings().audioCuesEnabled;

const playCue = async (notes, tone = DICTATION_TONE) => {
  try {
    if (!isEnabled()) return;

    const context = await resumeContextIfNeeded();
    if (!context) {
      return;
    }

    const baseTime = context.currentTime + 0.005;
    notes.forEach((frequency, index) => {
      const noteStart = baseTime + index * (tone.duration + tone.gap);
      scheduleTone(context, frequency, noteStart, tone);
    });
  } catch (error) {
    logger.debug(
      "Failed to play dictation cue",
      { error: error instanceof Error ? error.message : String(error) },
      "audio"
    );
  }
};

export const playStartCue = () => playCue(START_NOTES);

export const playStopCue = () => playCue(STOP_NOTES);

export const playCallStartCue = () => playCue(CALL_START_NOTES, CALL_TONE);

export const playCallEndCue = () => playCue(CALL_END_NOTES, CALL_TONE);
