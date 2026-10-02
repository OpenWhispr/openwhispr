// Pure gating for the recording-start Whisper prewarm — no Electron/IPC
// dependencies, so it can run in the renderer and be unit-tested directly.
// Mirrors the exact provider check AudioManager.processAudio() uses to route a
// dictation to processWithLocalWhisper (see audioManager.js): local whisper.cpp
// only, never cloud, LAN/remote-self-hosted, Parakeet, or Cohere.
export function shouldPrewarmLocalWhisper(settings = {}) {
  return (
    settings.useLocalWhisper === true &&
    settings.localTranscriptionProvider === "whisper" &&
    typeof settings.whisperModel === "string" &&
    settings.whisperModel.length > 0
  );
}
