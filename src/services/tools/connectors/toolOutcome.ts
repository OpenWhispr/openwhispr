import i18n from "../../../i18n";
import type { ToolResult } from "../ToolRegistry";
import type { ApprovalOutcome, ConnectorPrepareResult } from "../../../types/connectors";

const NO_RETRY = "Do not retry this action unless the user asks you to.";

// Connector results always return success: true, so the model gets the
// structured status (the AI SDK path turns failures into a bare error string).
// data is for the model; displayText is the user's tool step, so it is
// localized and never carries codes.
export function needsClarificationResult(message: string, candidates: string[] = []): ToolResult {
  return {
    success: true,
    data: { status: "needs_clarification", message, candidates },
    displayText: i18n.t("connectors.toolStatus.needsDetails"),
  };
}

export function unavailableResult(reason: string): ToolResult {
  return {
    success: true,
    data: { status: "unavailable", reason, guidance: NO_RETRY },
    displayText: i18n.t(
      reason === "policy_blocked" ? "connectors.policyOff" : "connectors.toolStatus.unavailable"
    ),
  };
}

export function notSentResult(
  reason: string,
  guidance: string = NO_RETRY,
  displayText: string = i18n.t("connectors.approval.notSent")
): ToolResult {
  return {
    success: true,
    data: { status: "not_sent", reason, guidance },
    displayText,
  };
}

export function failedResult(errorCode: string, message: string): ToolResult {
  return {
    success: true,
    data: { status: "failed", errorCode, error: message },
    displayText: i18n.t(`connectors.toolStatus.errors.${errorCode}`, {
      defaultValue: i18n.t("connectors.toolStatus.failed"),
    }),
  };
}

export function unknownResult(guidance: string): ToolResult {
  return {
    success: true,
    data: { status: "unknown", guidance: `${guidance} ${NO_RETRY}` },
    displayText: i18n.t("connectors.toolStatus.unknown"),
  };
}

export function prepareFailureResult(
  result: Exclude<ConnectorPrepareResult, { status: "ready" }>
): ToolResult {
  switch (result.status) {
    case "needs_clarification":
      return needsClarificationResult(result.message, result.candidates);
    case "failed":
      return failedResult(result.errorCode, result.message);
    case "unavailable":
      return unavailableResult(result.reason);
  }
}

export function approvalOutcomeResult(outcome: ApprovalOutcome, destination: string): ToolResult {
  switch (outcome.state) {
    case "sent":
      return {
        success: true,
        data: {
          status: "sent",
          url: outcome.url,
          destination,
          ...(outcome.finalText !== undefined ? { finalText: outcome.finalText } : {}),
        },
        displayText: i18n.t("connectors.approval.sent", { destination }),
      };
    case "cancelled":
      return {
        success: true,
        data: {
          status: "cancelled_by_user",
          guidance: `The user cancelled this action. ${NO_RETRY} Ask what they would like to change if it is unclear.`,
        },
        displayText: i18n.t("connectors.approval.cancelled"),
      };
    case "not_sent":
      return notSentResult(outcome.reason);
    case "failed":
      return failedResult(outcome.errorCode, outcome.message);
    case "unknown":
      return {
        success: true,
        data: {
          status: "unknown",
          destination,
          checkUrl: outcome.checkUrl,
          guidance: `It may or may not have been sent. ${NO_RETRY} Tell the user to check ${destination}.`,
        },
        displayText: i18n.t("connectors.approval.unknown", { destination }),
      };
  }
}
