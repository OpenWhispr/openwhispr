// Non-destructive provider switching: every provider keeps its own remembered
// {model, baseUrl} per scope, so selecting another provider never overwrites a
// configured one (e.g. a custom endpoint wiped by trying Tinfoil).
export function swapTranscriptionProviderConfig({
  configs,
  scope,
  fromProvider,
  fromModel,
  fromBaseUrl,
  toProvider,
}) {
  const scopeConfigs = { ...(configs?.[scope] || {}) };

  if (fromProvider) {
    const model = (fromModel || "").trim();
    const baseUrl = (fromBaseUrl || "").trim();
    // Empty values are omitted so meeting/upload twins keep falling back to base.
    scopeConfigs[fromProvider] = { ...(model ? { model } : {}), ...(baseUrl ? { baseUrl } : {}) };
  }

  const remembered = scopeConfigs[toProvider] || {};
  return {
    configs: { ...configs, [scope]: scopeConfigs },
    model: remembered.model || "",
    baseUrl: remembered.baseUrl || "",
  };
}
