import type { InferenceProvider } from "./types";
import { anthropicProvider } from "./anthropic";
import { geminiProvider } from "./gemini";
import { groqProvider } from "./groq";
import { localProvider } from "./local";
import { enterpriseProvider } from "./enterprise";
import { openwhisprProvider } from "./openwhispr";
import { lanProvider } from "./lan";

export const PROVIDER_REGISTRY: Readonly<Record<string, InferenceProvider>> = Object.freeze({
  anthropic: anthropicProvider,
  gemini: geminiProvider,
  groq: groqProvider,
  local: localProvider,
  bedrock: enterpriseProvider,
  azure: enterpriseProvider,
  vertex: enterpriseProvider,
  openwhispr: openwhisprProvider,
  lan: lanProvider,
});

export type { InferenceProvider, ProviderContext, ProviderCallParams } from "./types";
