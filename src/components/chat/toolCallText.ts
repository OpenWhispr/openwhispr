import type { TFunction } from "i18next";
import type { InteractionRecord } from "../../types/agentInteractions";
import { CONNECTION_TARGET_NAMES } from "../../config/agentCapabilities";
import { loadSkillTarget } from "../../utils/skillContext";
import { readSkillCardRecord, SKILL_CARD_TOOLS } from "./skillCardRecord";
import type { ToolCallInfo } from "./types";

// What a call that asked the user came to, on its step once it stopped.
function interactionOutcome({ result }: InteractionRecord, t: TFunction): string {
  if (!result || result.status === "not_answered") {
    return t("agentMode.interactions.status.notAnswered");
  }
  if (result.status === "connected") {
    return t("agentMode.interactions.status.connected", {
      name: CONNECTION_TARGET_NAMES[result.target],
    });
  }
  if (result.status === "unavailable") return t("connectors.toolStatus.unavailable");
  return t(`agentMode.interactions.status.${result.status}`);
}

/**
 * A tool call's step text: what it is doing while it runs, then what it came
 * to (a stopped call reads like a finished one, with its outcome).
 */
export function toolCallStepText(toolCall: ToolCallInfo, t: TFunction): string {
  if (toolCall.name === "load_skill" && toolCall.status !== "executing") {
    const name = toolCall.failed ? loadSkillTarget(toolCall.arguments)?.name : toolCall.result;
    if (name)
      return t(toolCall.failed ? "skills.chat.usingSkillFailed" : "skills.chat.usingSkill", {
        name,
      });
  }
  switch (toolCall.status) {
    case "executing":
      return t(`agentMode.tools.${toolCall.name}Status`, { defaultValue: toolCall.name });
    case "stopped":
      return toolCall.interaction
        ? interactionOutcome(toolCall.interaction, t)
        : t("agentMode.turn.stopped");
    case "completed":
      if (toolCall.name === "copy_to_clipboard") return t("agentMode.tools.copiedToClipboard");
      return toolCall.result || toolCall.name;
    case "error":
      return toolCall.result || toolCall.name;
  }
}

/** The calls a reply shows as steps; the help-grounding pseudo-tool is internal. */
export function visibleToolCalls(toolCalls: ToolCallInfo[] | undefined): ToolCallInfo[] {
  return (toolCalls ?? []).filter(
    (call) =>
      call.name !== "grounded_product_help" &&
      (!SKILL_CARD_TOOLS.has(call.name) || call.status === "executing" || readSkillCardRecord(call))
  );
}
