import { registryData } from "./registryData.js";
import { readCachedTinfoilModels } from "./tinfoilModelCache";
import { readCachedOpencodeModels } from "./opencodeModelCache";
import { defaultOpencodeBaseUrl } from "../config/opencodeModelPolicy.js";
import type { CloudModelDefinition, CloudProviderData } from "./ModelRegistry";

// A leaf shared with settings startup: the provider's live discovery can retire
// models without mutating the signed catalog or importing the settings store.
const cached = readCachedTinfoilModels().models;
let tinfoilOverlay: CloudModelDefinition[] | null = cached.length ? cached : null;

// OpenCode Go/Zen have no signed-catalog entries: every model they serve arrives
// through the live /models fetch, so the providers are registered here in code
// with an offline seed each. If the signed catalog ever lists them, it wins and
// these shells stay out of the way (see getCloudModelProviders).
//
// The seed is verified against live payloads; the seedees double as the offline
// fallback. A follow-up should move these providers into the model-registry
// repo so a vendor sync carries them like every other provider.
interface OpencodeShell extends CloudProviderData {
  id: "opencode-go" | "opencode-zen";
}

const OPENCODE_SHELLS: OpencodeShell[] = [
  {
    id: "opencode-go",
    name: "OpenCode Go",
    defaultModel: "glm-5.3",
    models: [
      {
        id: "glm-5.3",
        name: "GLM-5.3",
        description:
          "Flagship GLM model for long-horizon coding, agents, and complex project delivery",
        tokenParam: "max_tokens",
        supportsTemperature: true,
        protocol: "chat-completions",
        baseUrl: defaultOpencodeBaseUrl("chat-completions"),
      },
      {
        id: "deepseek-v4.1-flash",
        name: "DeepSeek V4.1 Flash",
        description: "DeepSeek V4.1 Flash model for reasoning and agentic coding",
        tokenParam: "max_tokens",
        supportsTemperature: true,
        protocol: "chat-completions",
        baseUrl: defaultOpencodeBaseUrl("chat-completions"),
      },
      {
        id: "kimi-k2.7-code",
        name: "Kimi K2.7 Code",
        description:
          "Coding-focused Kimi model, stronger on long-horizon repo work with less overthinking",
        tokenParam: "max_tokens",
        supportsTemperature: false,
        protocol: "chat-completions",
        baseUrl: defaultOpencodeBaseUrl("chat-completions"),
      },
      {
        id: "minimax-m3.1-flash",
        name: "MiniMax M3.1 Flash",
        description:
          "Frontier multimodal coding model with 1M context window and tunable thinking depth",
        tokenParam: "max_tokens",
        supportsTemperature: true,
        protocol: "chat-completions",
        baseUrl: defaultOpencodeBaseUrl("chat-completions"),
      },
    ],
  },
  {
    id: "opencode-zen",
    name: "OpenCode Zen",
    defaultModel: "glm-5.3",
    models: [
      {
        id: "glm-5.3",
        name: "GLM-5.3",
        description:
          "Flagship GLM model for long-horizon coding, agents, and complex project delivery",
        tokenParam: "max_tokens",
        supportsTemperature: true,
        protocol: "chat-completions",
        baseUrl: defaultOpencodeBaseUrl("chat-completions"),
      },
      {
        id: "deepseek-v4.1-flash",
        name: "DeepSeek V4.1 Flash",
        description: "DeepSeek V4.1 Flash model for reasoning and agentic coding",
        tokenParam: "max_tokens",
        supportsTemperature: true,
        protocol: "chat-completions",
        baseUrl: defaultOpencodeBaseUrl("chat-completions"),
      },
      {
        id: "kimi-k3",
        name: "Kimi K3",
        description:
          "Multimodal Kimi model with 1M context and toggleable max-effort thinking for long-horizon agent work",
        tokenParam: "max_tokens",
        supportsTemperature: false,
        protocol: "chat-completions",
        baseUrl: defaultOpencodeBaseUrl("chat-completions"),
      },
      {
        id: "minimax-m3",
        name: "MiniMax-M3",
        description:
          "MiniMax multimodal model for long-context coding, perception, and agent planning",
        tokenParam: "max_tokens",
        supportsTemperature: true,
        protocol: "chat-completions",
        baseUrl: defaultOpencodeBaseUrl("chat-completions"),
      },
    ],
  },
];

const opencodeOverlays = new Map<string, CloudModelDefinition[] | null>();
for (const shell of OPENCODE_SHELLS) {
  const cachedModels = readCachedOpencodeModels(shell.id).models;
  opencodeOverlays.set(shell.id, cachedModels.length ? cachedModels : null);
}

export function getOpencodeShell(providerId: string): OpencodeShell | undefined {
  return OPENCODE_SHELLS.find((shell) => shell.id === providerId);
}

export function getOpencodeDefaultModelId(providerId: string): string | undefined {
  return getOpencodeShell(providerId)?.defaultModel;
}

export function getCloudModelProviders(): CloudProviderData[] {
  const providers = registryData.cloudProviders.map((provider) =>
    provider.id === "tinfoil" && tinfoilOverlay ? { ...provider, models: tinfoilOverlay } : provider
  );
  for (const shell of OPENCODE_SHELLS) {
    if (providers.some((provider) => provider.id === shell.id)) continue;
    const overlay = opencodeOverlays.get(shell.id);
    providers.push(overlay ? { ...shell, models: overlay } : shell);
  }
  return providers;
}

export function setOpencodeModelOverlay(providerId: string, models: CloudModelDefinition[]): void {
  opencodeOverlays.set(providerId, models);
}

export function setTinfoilModelOverlay(models: CloudModelDefinition[]): void {
  tinfoilOverlay = models;
}
