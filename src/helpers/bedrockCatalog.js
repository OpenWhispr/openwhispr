// On-demand models are invoked by their bare foundation-model ID;
// INFERENCE_PROFILE-only models must go through the geo-scoped cross-region
// profile (us./eu./apac.) that the target region actually serves.

function profileIdByModelId(inferenceProfileSummaries) {
  const map = new Map();
  for (const profile of inferenceProfileSummaries || []) {
    if (!profile?.inferenceProfileId) continue;
    for (const model of profile.models || []) {
      const modelId = model?.modelArn?.split("/").pop();
      if (modelId && !map.has(modelId)) map.set(modelId, profile.inferenceProfileId);
    }
  }
  return map;
}

function normalizeBedrockCatalog(modelSummaries, inferenceProfileSummaries) {
  const profiles = profileIdByModelId(inferenceProfileSummaries);
  const seen = new Set();
  const models = [];

  for (const summary of modelSummaries || []) {
    if (!summary?.modelId) continue;
    if (!(summary.outputModalities || []).includes("TEXT")) continue;
    const status = summary.modelLifecycle?.status;
    if (status && status !== "ACTIVE") continue;

    const types = summary.inferenceTypesSupported || [];
    const value = types.includes("ON_DEMAND") ? summary.modelId : profiles.get(summary.modelId);
    if (!value || seen.has(value)) continue;
    seen.add(value);

    models.push({
      value,
      label: summary.modelName || summary.modelId,
      vendor: summary.providerName || "",
    });
  }

  models.sort((a, b) => a.vendor.localeCompare(b.vendor) || a.label.localeCompare(b.label));
  return models;
}

module.exports = { normalizeBedrockCatalog };
