import type { InferenceScope } from "../config/inferenceScopes";

export type ManagedEnterpriseProvider = "bedrock" | "azure";
export type ManagedEnterpriseProviderMode = "disabled" | "managed_default" | "managed_required";
export type EnterpriseSetupMode = "auto" | "managed" | "manual";

export interface ManagedEnterpriseProviderRecord {
  provider: ManagedEnterpriseProvider;
  mode: ManagedEnterpriseProviderMode;
  allowManualSetup: boolean;
  config: {
    scopeDefaults: Partial<Record<InferenceScope, string>>;
    roleArn?: string;
    region?: string;
    allowedModels?: string[];
    tenantId?: string;
    clientId?: string;
    endpoint?: string;
    apiVersion?: string;
    allowedDeployments?: string[];
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
  inferenceScope: InferenceScope;
  provider: ManagedEnterpriseProvider;
  generation: number;
  providerVersion: number;
}
