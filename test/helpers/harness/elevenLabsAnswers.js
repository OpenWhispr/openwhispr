// What ElevenLabs' speech-to-text route answered in November 2026, each with HTTP 400,
// less the request_id that differs on every answer.

// A keyterm it won't take. Its errors call them keywords.
const ELEVENLABS_KEYTERM_REFUSALS = [
  ["invalid_keyword", "Some keyword contains invalid characters"],
  ["invalid_keyword_spaces", "Each keyword can contain at most 4 spaces, but some contain 5."],
  ["invalid_keyword_length", "All keywords must be at most 50 characters."],
].map(([status, message]) => ({
  detail: {
    type: "validation_error",
    code: "invalid_parameters",
    message,
    status,
    param: "keywords",
  },
}));

// Audio under 100 ms, such as a tap of the hotkey.
const ELEVENLABS_AUDIO_TOO_SHORT = {
  detail: {
    type: "validation_error",
    code: "audio_too_short",
    message: "Audio is too short.",
    status: "audio_too_short",
    param: "file",
  },
};

// A file it could not decode.
const ELEVENLABS_BAD_AUDIO = {
  detail: {
    type: "validation_error",
    code: "invalid_audio",
    message: "File is corrupted. Please ensure it is playable audio.",
    status: "invalid_content",
    param: "audio_file",
  },
};

module.exports = { ELEVENLABS_KEYTERM_REFUSALS, ELEVENLABS_AUDIO_TOO_SHORT, ELEVENLABS_BAD_AUDIO };
