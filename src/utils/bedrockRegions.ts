// Bedrock cross-region inference profile IDs are geo-scoped (us./eu./apac.)
// and only resolve in regions within that geography. On-demand models use
// bare, prefix-free IDs that work in any region serving them.

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
