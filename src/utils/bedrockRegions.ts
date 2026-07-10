// AWS Bedrock cross-region inference profiles are geo-scoped: a profile ID is
// the foundation model ID prefixed with the geography it routes within
// (e.g. us.anthropic..., eu.anthropic..., apac.anthropic...). Invoking a
// profile from a region outside its geography fails with
// "The provided model identifier is invalid". On-demand models use the bare
// foundation model ID with no prefix and work as-is in any region that
// serves them.

const GEO_PROFILE_PATTERN = /^(us|eu|apac)\.(.+)$/;

export function bedrockGeoPrefix(region: string): "us" | "eu" | "apac" {
  if (region.startsWith("eu-")) return "eu";
  if (region.startsWith("ap-")) return "apac";
  return "us";
}

export function adjustBedrockModelForRegion(modelId: string, region: string): string {
  const match = GEO_PROFILE_PATTERN.exec(modelId);
  if (!match) return modelId;
  return `${bedrockGeoPrefix(region)}.${match[2]}`;
}
