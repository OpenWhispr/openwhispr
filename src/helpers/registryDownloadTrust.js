// Registry CI checks who publishes a download, but only for changes that went through it.
// The app checks again because a stolen signing key skips CI, and the signature would then
// be all that stands between a catalog and every install. The registry's reader already
// limits downloads to huggingface.co and three GitHub owners, so publishers are checked here
// for Hugging Face. Copied from registry/trusted-publishers.json: a model from a newer
// publisher reaches installs from the app release that lists it.
const TRUSTED_HF_PUBLISHERS = new Set([
  "LiquidAI",
  "Qwen",
  "bartowski",
  "ggerganov",
  "ggml-org",
  "google",
  "mistralai",
  "mradermacher",
  "oruk",
  "unsloth",
]);

const LOCATION_FIELDS = [
  "hfRepo",
  "revision",
  "fileName",
  "draftHfRepo",
  "draftRevision",
  "draftFileName",
  "downloadUrl",
];

const publisherIsTrusted = (repo) => !repo || TRUSTED_HF_PUBLISHERS.has(repo.split("/")[0]);

function urlIsTrusted(value) {
  if (!value) return true;
  const url = new URL(value);
  return url.hostname !== "huggingface.co" || publisherIsTrusted(url.pathname.slice(1));
}

function isTrusted(model, shipped) {
  if (model.retired) return true;
  if (![model.hfRepo, model.draftHfRepo].every(publisherIsTrusted)) return false;
  if (![model.downloadUrl, model.manifestUrl].every(urlIsTrusted)) return false;
  // A download this release didn't ship has to name the bytes it expects.
  const unchanged = shipped && LOCATION_FIELDS.every((field) => model[field] === shipped[field]);
  return !!unchanged || (!!model.sha256 && (!model.draftFileName || !!model.draftSha256));
}

// An entry that fails keeps its shipped copy, or leaves when this release has none.
function withTrustedDownloads(data, bundled, onRejected = () => {}) {
  const trusted = structuredClone(data);
  for (const provider of trusted.localProviders ?? []) {
    const shipped = bundled.localProviders?.find((item) => item.id === provider.id)?.models ?? [];
    provider.models = provider.models.flatMap((model) => {
      const original = shipped.find((item) => item.id === model.id);
      if (isTrusted(model, original)) return [model];
      onRejected(model.id);
      return original ? [structuredClone(original)] : [];
    });
  }
  for (const section of ["whisperModels", "parakeetModels"]) {
    for (const [id, model] of Object.entries(trusted[section] ?? {})) {
      const original = Object.hasOwn(bundled[section] ?? {}, id) ? bundled[section][id] : undefined;
      if (isTrusted(model, original)) continue;
      onRejected(id);
      if (original) trusted[section][id] = structuredClone(original);
      else delete trusted[section][id];
    }
  }
  return trusted;
}

module.exports = { withTrustedDownloads, TRUSTED_HF_PUBLISHERS };
