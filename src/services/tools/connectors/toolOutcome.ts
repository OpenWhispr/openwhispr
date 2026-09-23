import type { ToolResult } from "../ToolRegistry";
import type { ApprovalOutcome, ConnectorPrepareResult } from "../../../types/connectors";

const NO_RETRY = "Do not retry this action unless the user asks you to.";

// Connector results always return success: true, so the model gets the
// structured status (the AI SDK path turns failures into a bare error string).
export function needsClarificationResult(message: string, candidates: string[] = []): ToolResult {
  return {
    success: true,
    data: { status: "needs_clarification", message, candidates },
    displayText: message,
  };
}

export function unavailableResult(reason: string): ToolResult {
  return {
    success: true,
    data: { status: "unavailable", reason, guidance: NO_RETRY },
    displayText: `Unavailable: ${reason}`,
  };
}

export function failedResult(errorCode: string, message: string): ToolResult {
  return {
    success: true,
    data: { status: "failed", errorCode, error: message },
    displayText: message,
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
        displayText: `Sent to ${destination}`,
      };
    case "cancelled":
      return {
        success: true,
        data: {
          status: "cancelled_by_user",
          guidance: `The user cancelled this action. ${NO_RETRY} Ask what they would like to change if it is unclear.`,
        },
        displayText: "Cancelled",
      };
    case "not_sent":
      return {
        success: true,
        data: { status: "not_sent", reason: outcome.reason, guidance: NO_RETRY },
        displayText: "Not sent",
      };
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
        displayText: `Couldn't confirm. Check ${destination}.`,
      };
  }
}
