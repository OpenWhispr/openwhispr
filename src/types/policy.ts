import type { InferenceMode } from "./electron";

/**
 * Organization policy delivered by the OpenWhispr API and enforced by the app.
 *
 * Mirrors the canonical schema in `openwhispr-api/lib/policy-schema.ts` and
 * `openwhispr-admin/lib/policy-schema.ts` — keep the three in sync. Mode ids are
 * validated strictly; BYOK provider ids are validated shape-only (see
 * `allowedByokProviders`) so the server enum can grow ahead of this build.
 */

export type LocalHistoryMode = "user_choice" | "always_on" | "always_off";
export type ExternalSharingMode = "allowed" | "domain_only" | "disabled";

export interface OrgPolicy {
  version: number;
  transcription: {
    allowedModes: InferenceMode[];
    /**
     * Registry provider ids plus "custom". Validated shape-only so a provider
     * added server-side can't invalidate the policy on older builds; ids this
     * build does not know are filtered out at enforcement time and grant nothing.
     */
    allowedByokProviders: string[];
    /** Absent on servers that predate the field; absent means none. */
    allowedEnterpriseProviders?: string[];
  };
  llm: {
    allowedModes: InferenceMode[];
    /** Registry provider ids plus "custom" and "openrouter"; same forward-compat rule as transcription. */
    allowedByokProviders: string[];
    allowedEnterpriseProviders: string[];
  };
  features: {
    agentEnabled: boolean;
    webSearchEnabled: boolean;
    /** Absent on servers that predate the field; absent means allowed. */
    screenContextEnabled?: boolean;
    /**
     * Server-only Mem0 agent-memory gate, enforced by the API on
     * `/api/agent/stream`; the app never reads it. Absent on older servers.
     */
    memoryEnabled?: boolean;
  };
  sharing: {
    externalLinkSharing: ExternalSharingMode;
  };
  dataRetention: {
    audioRetentionMaxDays: number | null;
    localHistoryMode: LocalHistoryMode;
    cloudBackupAllowed: boolean;
  };
  /**
   * Model ids (whisper/parakeet registry keys) members must download.
   * Absent on servers that predate the field; absent/empty means none.
   * Validated shape-only so future server-side ids can't invalidate the
   * policy — unknown ids are filtered at enforcement time.
   */
  requiredLocalModels?: string[];
  minAppVersion: string | null;
}

/** Which allowlist a mode/provider check applies to. */
export type PolicyScope = "transcription" | "llm";
