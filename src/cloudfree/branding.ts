/**
 * CloudFree OpenWhispr — Branding config (renderer-side)
 *
 * Single source of truth for all fork-specific branding and support links.
 * When upstream merges overwrite SupportDropdown or other components,
 * the CloudFreeSupportDropdown wrapper uses these values instead.
 */

export const BRANDING = {
  name: "CloudFree OpenWhispr",
  shortName: "CloudFree",
  description: "A hardened, privacy-focused fork of OpenWhispr",
  upstream: {
    name: "OpenWhispr",
    url: "https://openwhispr.com",
    repo: "https://github.com/OpenWhispr/openwhispr",
  },
  fork: {
    repo: "https://github.com/jrschumacher/cloudfree-openwhispr",
    issues: "https://github.com/jrschumacher/cloudfree-openwhispr/issues",
  },
  support: {
    bugReportUrl: "https://github.com/jrschumacher/cloudfree-openwhispr/issues",
    bugReportLabel: "Report an Issue",
    attribution: "CloudFree OpenWhispr is an independent hardened fork",
    disclaimer: "Not affiliated with or supported by the upstream project.",
  },
} as const;
