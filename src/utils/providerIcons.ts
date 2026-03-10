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
};
// Soniox has no icon asset yet; getProviderIcon returns
// undefined, and ProviderIcon.tsx falls back to a Brain icon.

export function getProviderIcon(provider: string): string | undefined {
  return PROVIDER_ICONS[provider];
}

export const MONOCHROME_PROVIDERS = ["openai", "whisper", "anthropic", "openai-oss"] as const;

export function isMonochromeProvider(provider: string): boolean {
  return (MONOCHROME_PROVIDERS as readonly string[]).includes(provider);
}
