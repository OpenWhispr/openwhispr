import type { InferenceProvider } from "./types";
import logger from "../../../utils/logger";

export const CLI_AGENT_PROVIDER_IDS = ["claude-code", "codex"] as const;
export type CliAgentProviderId = (typeof CLI_AGENT_PROVIDER_IDS)[number];
export const DEFAULT_CLI_AGENT_PROVIDER: CliAgentProviderId = CLI_AGENT_PROVIDER_IDS[0];

export function isCliAgentProvider(provider?: string): provider is CliAgentProviderId {
  return CLI_AGENT_PROVIDER_IDS.includes(provider as CliAgentProviderId);
}

export const cliAgentProvider: InferenceProvider = {
  id: "cli-agent",
  async call({ text, model, config }) {
    if (typeof window === "undefined" || !window.electronAPI?.processCliAgent) {
      throw new Error("CLI agent is not available in this environment");
    }
    const cli = isCliAgentProvider(config.provider)
      ? config.provider
      : DEFAULT_CLI_AGENT_PROVIDER;
    logger.logReasoning("CLI_AGENT_START", { cli, model, textLength: text.length });
    const startTime = Date.now();

    const result = await window.electronAPI.processCliAgent({
      cli,
      prompt: text,
      model,
      permissionMode: config.cliPermissionMode || "auto",
      workingDir: config.cliWorkingDir || "",
      timeoutSeconds: config.cliTimeoutSeconds ?? 240,
      sessionMinutes: config.cliSessionMinutes ?? 30,
      systemPrompt: config.systemPrompt || "",
      extraPrompt: config.cliExtraPrompt || "",
    });

    if (!result.success) {
      logger.logReasoning("CLI_AGENT_ERROR", { cli, error: result.error, code: result.errorCode });
      throw new Error(result.error);
    }
    if (result.permissionDenials?.length) {
      window.dispatchEvent(
        new CustomEvent("cli-agent-denials", { detail: result.permissionDenials })
      );
    }
    logger.logReasoning("CLI_AGENT_SUCCESS", {
      cli,
      processingTimeMs: Date.now() - startTime,
      resultLength: result.text.length,
    });
    return result.text;
  },
};
