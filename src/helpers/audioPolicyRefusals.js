// The server's refusals of an audio purpose. Each also means the snapshot that
// let the request through no longer matches the org's policy. Kept free of
// other imports so pure modules (cloudChunkPolicy, cliBridge) can share it.
const AUDIO_POLICY_REFUSAL_CODES = new Set([
  "POLICY_MEETING_RECORDING_DISABLED",
  "POLICY_AUDIO_UPLOAD_DISABLED",
  "AUDIO_PURPOSE_REQUIRED",
  "POLICY_UNRESOLVABLE",
]);

const isAudioPolicyRefusal = (failure) => AUDIO_POLICY_REFUSAL_CODES.has(failure?.code);

module.exports = { AUDIO_POLICY_REFUSAL_CODES, isAudioPolicyRefusal };
