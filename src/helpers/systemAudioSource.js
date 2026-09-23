// Where Windows note recording hears the other people in a call (#1546).
// "all-devices" is the native helper's process loopback, which records every
// app on every playback device (#960). "default-device" is Chromium's loopback
// of the Windows default output only, for setups whose virtual outputs (voice
// changers, audio cables) carry the user's own voice.
//
// Dependency-free so the main process can require() it and the renderer can
// import it.
export const SYSTEM_AUDIO_SOURCE_ALL_DEVICES = "all-devices";
export const SYSTEM_AUDIO_SOURCE_DEFAULT_DEVICE = "default-device";
export const SYSTEM_AUDIO_SOURCES = [
  SYSTEM_AUDIO_SOURCE_ALL_DEVICES,
  SYSTEM_AUDIO_SOURCE_DEFAULT_DEVICE,
];
export const DEFAULT_SYSTEM_AUDIO_SOURCE = SYSTEM_AUDIO_SOURCE_ALL_DEVICES;

/**
 * Anything but a known value means today's behaviour, so a value synced raw
 * from another window, written by a newer build, or missing from an IPC call
 * can never opt a user out of recording every playback device.
 *
 * @param {unknown} value
 * @returns {"all-devices" | "default-device"}
 */
export function normalizeSystemAudioSource(value) {
  return SYSTEM_AUDIO_SOURCES.includes(value) ? value : DEFAULT_SYSTEM_AUDIO_SOURCE;
}
