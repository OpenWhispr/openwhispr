import openaiIcon from "@/assets/icons/providers/openai.svg";
import anthropicIcon from "@/assets/icons/providers/anthropic.svg";
import geminiIcon from "@/assets/icons/providers/gemini.svg";
import llamaIcon from "@/assets/icons/providers/llama.svg";
import mistralIcon from "@/assets/icons/providers/mistral.svg";
import qwenIcon from "@/assets/icons/providers/qwen.svg";
import groqIcon from "@/assets/icons/providers/groq.svg";
import nvidiaIcon from "@/assets/icons/providers/nvidia.svg";
import openaiOssIcon from "@/assets/icons/providers/openai-oss.svg";
import gemmaIcon from "@/assets/icons/providers/gemma.svg";
import liquidaiIcon from "@/assets/icons/providers/liquidai.svg";
import bedrockIcon from "@/assets/icons/providers/bedrock.svg";
import azureIcon from "@/assets/icons/providers/azure.svg";
import vertexIcon from "@/assets/icons/providers/vertex.svg";
import xaiIcon from "@/assets/icons/providers/xai.svg";
import cortiIcon from "@/assets/icons/providers/corti.svg";
import openrouterIcon from "@/assets/icons/providers/openrouter.svg";
import tinfoilIcon from "@/assets/icons/providers/tinfoil.svg";

export const PROVIDER_ICONS: Record<string, string> = {
  openai: openaiIcon,
  whisper: openaiIcon,
  anthropic: anthropicIcon,
  gemini: geminiIcon,
  llama: llamaIcon,
  mistral: mistralIcon,
  qwen: qwenIcon,
  groq: groqIcon,
  nvidia: nvidiaIcon,
  "openai-oss": openaiOssIcon,
  gemma: gemmaIcon,
  liquidai: liquidaiIcon,
  bedrock: bedrockIcon,
  azure: azureIcon,
  vertex: vertexIcon,
  xai: xaiIcon,
  corti: cortiIcon,
  openrouter: openrouterIcon,
  tinfoil: tinfoilIcon,
};

export function getProviderIcon(provider: string): string | undefined {
  return PROVIDER_ICONS[provider];
}

export const MONOCHROME_PROVIDERS = [
  "openai",
  "whisper",
  "anthropic",
  "openai-oss",
  "liquidai",
  "xai",
  "corti",
  "openrouter",
  "tinfoil",
] as const;

export function isMonochromeProvider(provider: string): boolean {
  return (MONOCHROME_PROVIDERS as readonly string[]).includes(provider);
}

// OpenRouter-style provider prefixes (the slug before "/") → our internal icon keys.
const REMOTE_PROVIDER_ALIASES: Record<string, string> = {
  google: "gemini",
  "meta-llama": "llama",
  meta: "llama",
  mistralai: "mistral",
  "x-ai": "xai",
  amazon: "bedrock",
};

// Resolves the icon for a remote provider prefix (e.g. "openai" from "openai/gpt-4").
// A model family with its own icon wins over the publisher prefix, so
// "google/gemma-7b" gets the Gemma icon rather than Gemini's.
export function getRemoteProviderIcon(
  prefix: string,
  modelName?: string
): {
  icon: string | undefined;
  invertInDark: boolean;
} {
  const base = prefix.startsWith("~") ? prefix.slice(1) : prefix;
  const family = modelName?.split(/[-.:@ ]/, 1)[0].toLowerCase();
  const key = family && PROVIDER_ICONS[family] ? family : (REMOTE_PROVIDER_ALIASES[base] ?? base);
  return { icon: PROVIDER_ICONS[key], invertInDark: isMonochromeProvider(key) };
}
