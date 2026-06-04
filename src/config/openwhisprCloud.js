const DEFAULT_OPENWHISPR_API_URL = "https://api.openwhispr.com";

function resolveOpenWhisprApiUrl(env = {}) {
  return (
    env.OPENWHISPR_API_URL ||
    env.VITE_OPENWHISPR_API_URL ||
    env.runtimeViteOpenWhisprApiUrl ||
    DEFAULT_OPENWHISPR_API_URL
  );
}

module.exports = {
  DEFAULT_OPENWHISPR_API_URL,
  resolveOpenWhisprApiUrl,
};
