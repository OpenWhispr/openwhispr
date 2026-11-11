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
const HASH_FIELDS = ["sha256", "draftSha256"];

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
  if (!shipped) return !!model.sha256 && (!model.draftFileName || !!model.draftSha256);
  // A shipped download changes one leg at a time, as registry CI requires: the signer names
  // a new hash, so a move must keep the hash this release shipped, and a hash this release
  // shipped is never dropped. A move together with a new hash needs an app release.
  const moved = LOCATION_FIELDS.some((field) => model[field] !== shipped[field]);
  if (moved)
    return (
      !!shipped.sha256 &&
      model.sha256 === shipped.sha256 &&
      (!model.draftFileName || (!!shipped.draftSha256 && model.draftSha256 === shipped.draftSha256))
    );
  return HASH_FIELDS.every((field) => !shipped[field] || !!model[field]);
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
