// On-demand models are invoked by their bare foundation-model ID;
// INFERENCE_PROFILE-only models must go through the geo-scoped cross-region
// profile (us./eu./apac.) that the target region actually serves.

function profileIdByModelId(inferenceProfileSummaries) {
  const map = new Map();
  const profiles = Array.isArray(inferenceProfileSummaries) ? inferenceProfileSummaries : [];
  for (const profile of profiles) {
    if (!profile?.inferenceProfileId) continue;
    const models = Array.isArray(profile.models) ? profile.models : [];
    for (const model of models) {
      const modelId =
        typeof model?.modelArn === "string" ? model.modelArn.split("/").pop() : undefined;
      if (modelId && !map.has(modelId)) map.set(modelId, profile.inferenceProfileId);
    }
  }
  return map;
}

function normalizeBedrockCatalog(modelSummaries, inferenceProfileSummaries) {
  const profiles = profileIdByModelId(inferenceProfileSummaries);
  const seen = new Set();
  const models = [];
  const summaries = Array.isArray(modelSummaries) ? modelSummaries : [];

  for (const summary of summaries) {
    if (!summary?.modelId || typeof summary.modelId !== "string") continue;
    const modalities = Array.isArray(summary.outputModalities) ? summary.outputModalities : [];
    if (!modalities.includes("TEXT")) continue;
    const status = summary.modelLifecycle?.status;
    if (status && status !== "ACTIVE") continue;

    const types = Array.isArray(summary.inferenceTypesSupported)
      ? summary.inferenceTypesSupported
      : [];
    const value = types.includes("ON_DEMAND") ? summary.modelId : profiles.get(summary.modelId);
    if (!value || seen.has(value)) continue;
    seen.add(value);

    const vendor = typeof summary.providerName === "string" ? summary.providerName : "";
    const label =
      typeof summary.modelName === "string" && summary.modelName
        ? summary.modelName
        : String(summary.modelId);

    models.push({
      value,
      label,
      vendor,
    });
  }

  models.sort((a, b) => a.vendor.localeCompare(b.vendor) || a.label.localeCompare(b.label));
  return models;
}

module.exports = { normalizeBedrockCatalog };
