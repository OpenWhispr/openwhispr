import voiceCall from "../config/voiceCall.json";
import type { VoiceCallLanguage, VoiceCallVoice } from "../services/voice/types";

export const VOICE_CALL_VOICES = Object.keys(voiceCall.voices) as VoiceCallVoice[];
export const VOICE_CALL_LANGUAGES = voiceCall.languages as VoiceCallLanguage[];
export const VOICE_CALL_SPEED = voiceCall.speed;

export function normalizeVoiceCallVoice(value: unknown): VoiceCallVoice {
  return VOICE_CALL_VOICES.includes(value as VoiceCallVoice)
    ? (value as VoiceCallVoice)
    : (voiceCall.defaultVoice as VoiceCallVoice);
}

export function normalizeVoiceCallLanguage(value: unknown): VoiceCallLanguage {
  return VOICE_CALL_LANGUAGES.includes(value as VoiceCallLanguage)
    ? (value as VoiceCallLanguage)
    : "auto";
}

/** A speed the stepper offers: a 0.25× step between 0.5× and 2×. */
export function normalizeVoiceCallSpeed(value: unknown): number {
  const { min, max, step } = VOICE_CALL_SPEED;
  const speed = Number(value);
  if (!Number.isFinite(speed)) return VOICE_CALL_SPEED.default;
  return Math.min(max, Math.max(min, Math.round(speed / step) * step));
}
