// Shared main-process wire contract. Managed destinations remain an exact allowlist.
const ORUKEET_BASE_URL = "https://orukeet.gizmovoice.ai";
const ORUKEET_MODEL = "orukeet-v0.1.0";
const ORUKEET_PCM_PROTOCOL = "orukeet.pcm.v1";
const ORUKEET_PIPELINE_PROTOCOL = "orukeet.pipeline.v2";
const ORUKEET_CLEANUP_VARIANT = "gemma12";
const ORUKEET_CLEANUP_MODEL = "gemma-4-12b";
const ORUKEET_SESSION_PATH = "/api/stt/orukeet/session";
const ORUKEET_PIPELINE_SESSION_PATH = "/api/stt/orukeet/pipeline-session";
const ORUKEET_PIPELINE_USAGE_PATH = "/api/stt/orukeet/pipeline-usage";
const ORUKEET_LANGUAGE_PREVIEW_URL = `${ORUKEET_BASE_URL}/preview/language-routing`;
const ORUKEET_PIPELINE_BASES = [
  "preview",
  "regions/us-west1",
  "regions/europe-west4",
  "regions/asia-southeast1",
].map((path) => `${ORUKEET_BASE_URL}/${path}/${ORUKEET_CLEANUP_VARIANT}`);
function isOrukeetClientToken(value, pipeline = false) {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9._-]+$/.test(value) &&
    value.length <= (pipeline ? 160 : 96)
  );
}
module.exports = {
  ORUKEET_BASE_URL,
  ORUKEET_MODEL,
  ORUKEET_PCM_PROTOCOL,
  ORUKEET_PIPELINE_PROTOCOL,
  ORUKEET_CLEANUP_VARIANT,
  ORUKEET_CLEANUP_MODEL,
  ORUKEET_SESSION_PATH,
  ORUKEET_PIPELINE_SESSION_PATH,
  ORUKEET_PIPELINE_USAGE_PATH,
  ORUKEET_LANGUAGE_PREVIEW_URL,
  ORUKEET_PIPELINE_BASES,
  isOrukeetClientToken,
};
