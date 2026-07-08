import type { InferenceMode } from "./electron";

/**
 * Organization policy delivered by the OpenWhispr API and enforced by the app.
 *
 * Mirrors the canonical schema in `openwhispr-api/lib/policy-schema.ts` and
 * `openwhispr-admin/lib/policy-schema.ts` — keep the three in sync. Provider and
 * mode ids match the model registry exactly.
 */

export type LocalHistoryMode = "user_choice" | "always_on" | "always_off";
export type ExternalSharingMode = "allowed" | "domain_only" | "disabled";

export interface OrgPolicy {
  version: number;
  transcription: {
    allowedModes: InferenceMode[];
    allowedByokProviders: string[];
  };
  llm: {
    allowedModes: InferenceMode[];
    allowedByokProviders: string[];
    allowedEnterpriseProviders: string[];
  };
  features: {
    agentEnabled: boolean;
    webSearchEnabled: boolean;
  };
  sharing: {
    externalLinkSharing: ExternalSharingMode;
  };
  dataRetention: {
    audioRetentionMaxDays: number | null;
    localHistoryMode: LocalHistoryMode;
    cloudBackupAllowed: boolean;
  };
  minAppVersion: string | null;
}

/** Which allowlist a mode/provider check applies to. */
export type PolicyScope = "transcription" | "llm";
