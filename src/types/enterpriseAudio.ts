export interface EnterpriseAudioSetupContext {
  accountId: string;
  workspaceId: string;
  authGeneration: number;
  generation: number;
  providerVersion: number;
  configFingerprint?: string;
}

export interface EnterpriseAudioAuthentication {
  type: "bearer" | "api-key";
  credentialSlot: string;
}

export interface EnterpriseAudioOperation {
  allowedDeployments: string[];
  defaultDeployment: string;
  endpoint?: string;
  authentication?: EnterpriseAudioAuthentication;
  maxUploadBytes?: number;
  supportsPrompt?: boolean;
  supportsLanguage?: boolean;
  protocol?: "openai-transcription-preview" | "openai-transcription-ga";
  sampleRate?: 24000;
  apiVersion?: string;
  tokenScope?: "https://cognitiveservices.azure.com/.default" | "https://ai.azure.com/.default";
}

export interface EnterpriseAudioNetwork {
  caBundleId?: string;
  proxy?: {
    mode: "system" | "fixed" | "direct";
    url?: string;
    bypass?: string[];
    mandatory?: boolean;
    credentialSlot?: string;
  };
  connectTimeoutMs?: number;
  httpTimeoutMs?: number;
  idleTimeoutMs?: number;
  sessionMaxMs?: number;
}

export interface EnterpriseCaBundle {
  id: string;
  name: string;
  pem: string;
  fingerprint: string;
  certificates: { subject: string; validTo: string; fingerprint: string }[];
}
