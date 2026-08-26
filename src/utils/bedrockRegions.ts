// Bedrock cross-region inference profile IDs are geo-scoped (us./eu./apac.)
// and only resolve in regions within that geography. On-demand models use
// bare, prefix-free IDs that work in any region serving them.

const GEO_PROFILE_PATTERN = /^(us|eu|apac)\.(.+)$/;

export const BEDROCK_REGIONS = [
  "us-east-1",
  "us-east-2",
  "us-west-1",
  "us-west-2",
  "ca-central-1",
  "eu-central-1",
  "eu-west-1",
  "eu-west-2",
  "eu-west-3",
  "eu-north-1",
  "eu-south-1",
  "ap-south-1",
  "ap-southeast-1",
  "ap-southeast-2",
  "ap-southeast-3",
  "ap-northeast-1",
  "ap-northeast-2",
  "ap-northeast-3",
  "sa-east-1",
  "me-central-1",
  "af-south-1",
] as const;

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
