import type { InferenceScope } from "../config/inferenceScopes";

export type ManagedEnterpriseProvider = "bedrock" | "azure";
export type ManagedEnterpriseProviderMode = "disabled" | "managed_default" | "managed_required";
export type EnterpriseSetupMode = "auto" | "managed" | "manual";

/** The managed speech-to-text scope; resolved from the Azure `transcription` config section. */
export type ManagedTranscriptionScope = "transcription";
export type ManagedEnterpriseScope = InferenceScope | ManagedTranscriptionScope;

export interface ManagedEnterpriseProviderRecord {
  provider: ManagedEnterpriseProvider;
  mode: ManagedEnterpriseProviderMode;
  allowManualSetup: boolean;
  config: {
    /** Present when the text-processing section is configured. */
    scopeDefaults?: Partial<Record<InferenceScope, string>>;
    roleArn?: string;
    region?: string;
    allowedModels?: string[];
    tenantId?: string;
    clientId?: string;
    endpoint?: string;
    apiVersion?: string;
    allowedDeployments?: string[];
    /** Azure-only managed speech-to-text section. */
    transcription?: {
      allowedDeployments: string[];
      defaultDeployment: string;
    };
  };
  version: number;
  updatedAt: string;
}

export interface ManagedEnterpriseConfig {
  workspaceId: string;
  version: number;
  generation: number;
  refreshAfter?: string;
  supportedClouds?: { bedrock: ["aws", "aws-us-gov"]; azure: ["public"] };
  azureEndpointContract?: "resource-origin";
  identity: {
    issuer: string;
    jwksUri: string;
    subject: string;
    audiences: Record<ManagedEnterpriseProvider, string>;
  };
  providers: ManagedEnterpriseProviderRecord[];
}

export type ManagedEnterpriseScopeResolution =
  | { kind: "manual" }
  | {
      kind: "managed";
      provider: ManagedEnterpriseProvider;
      model: string;
      mode: ManagedEnterpriseProviderMode;
      allowManualSetup: boolean;
      record: ManagedEnterpriseProviderRecord;
    }
  | { kind: "error"; code: string; message: string };

export interface ManagedEnterpriseRequestContext {
  accountId: string;
  workspaceId: string;
  authGeneration: number;
  setupMode: EnterpriseSetupMode;
  inferenceScope: ManagedEnterpriseScope;
  provider: ManagedEnterpriseProvider;
  generation: number;
  providerVersion: number;
}
