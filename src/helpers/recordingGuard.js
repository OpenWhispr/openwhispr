// A recorded WebM/Opus blob with no audio frames — produced when the dictation
// hotkey toggles recording on and off within milliseconds (an accidental
// double-tap, or the KDE double-trigger fixed in main.js) — is essentially just
// the container header, well under 256 bytes. Real speech, even a single short
// word, produces far more. We gate on size, not wall-clock duration: a genuinely
// short utterance can last under any reasonable time threshold yet still carry
// real audio, so a duration gate would silently drop it. See issue #864.
export const MIN_AUDIO_BYTES = 256;

export function isEmptyRecording(blobSize) {
  const size = typeof blobSize === "number" && Number.isFinite(blobSize) ? blobSize : 0;
  return size < MIN_AUDIO_BYTES;
}
