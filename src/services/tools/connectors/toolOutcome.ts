import i18n from "../../../i18n";
import { connectorErrorText } from "../../../utils/connectorErrorCopy";
import { issueSentCopy, issueUnknownCopy, issueVerb } from "../../../utils/issueApprovalFields";
import type { ToolResult } from "../ToolRegistry";
import type {
  ApprovalEdits,
  ApprovalOutcome,
  ConnectorPrepareResult,
} from "../../../types/connectors";

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

export function unavailableResult(
  reason: string,
  guidance: string = NO_RETRY,
  edits: ApprovalEdits = {}
): ToolResult {
  return {
    success: true,
    data: { status: "unavailable", reason, guidance, ...edits },
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

// connectorId picks that connector's own wording for the tool step, when it
// has any (Gmail's "Gmail needs to be reconnected").
export function failedResult(
  errorCode: string,
  message: string,
  connectorId?: string,
  edits: ApprovalEdits = {}
): ToolResult {
  return {
    success: true,
    data: { status: "failed", errorCode, error: message, ...edits },
    displayText: connectorErrorText(i18n.t, "toolStatus", connectorId ?? "", errorCode),
  };
}

// A direct action that may already have acted: the model must not retry it.
export function unknownResult(
  destination: string,
  guidance: string,
  displayText: string = i18n.t("connectors.toolStatus.unknown")
): ToolResult {
  return {
    success: true,
    data: { status: "unknown", destination, guidance: `${guidance} ${NO_RETRY}` },
    displayText,
  };
}

export function prepareFailureResult(
  result: Exclude<ConnectorPrepareResult, { status: "ready" }>,
  connectorId?: string
): ToolResult {
  switch (result.status) {
    case "needs_clarification":
      return needsClarificationResult(result.message, result.candidates);
    case "failed":
      return failedResult(result.errorCode, result.message, connectorId);
    case "unavailable":
      return unavailableResult(result.reason);
  }
}

export interface ApprovalOutcomeOptions {
  /** Replaces "Tell the user to check <destination>." (Gmail: the Sent folder). */
  unknownGuidance?: string;
  /** Picks the connector's own wording for a failed or unknown tool step. */
  connectorId?: string;
  /** The card's layout; an issue or comment reads "Created ENG-124" rather than "Sent to". */
  verbKey?: string;
}

// A connector with its own wording says where to look (Gmail: "Check your
// Gmail Sent folder."); an issue or comment names what may not exist; any
// other keeps the generic line.
function unknownDisplayText(destination: string, connectorId?: string, verbKey?: string): string {
  const verb = issueVerb(verbKey);
  if (verb) {
    const copy = issueUnknownCopy(verb, destination);
    return i18n.t(copy.key, copy.values);
  }
  const generic = i18n.t("connectors.approval.unknown", { destination });
  return connectorId
    ? i18n.t(`connectors.toolStatus.unknownSent.${connectorId}`, {
        destination,
        defaultValue: generic,
      })
    : generic;
}

function sentDisplayText(destination: string, resultLabel?: string, verbKey?: string): string {
  const verb = issueVerb(verbKey);
  if (!verb) return i18n.t("connectors.approval.sent", { destination });
  const copy = issueSentCopy(verb, destination, resultLabel);
  return i18n.t(copy.key, copy.values);
}

// What the user changed on the card, so the model describes (or proposes
// again) the email the user settled on, not the one it drafted.
export function userEdits({ finalText, final }: ApprovalEdits): ApprovalEdits {
  return {
    ...(finalText !== undefined ? { finalText } : {}),
    ...(final !== undefined ? { final } : {}),
  };
}

export function approvalOutcomeResult(
  outcome: ApprovalOutcome,
  destination: string,
  options: ApprovalOutcomeOptions = {}
): ToolResult {
  switch (outcome.state) {
    case "sent":
      return {
        success: true,
        data: {
          status: "sent",
          url: outcome.url,
          destination,
          ...userEdits(outcome),
          // What was created ("ENG-124"), so the model can name it.
          ...(outcome.resultLabel !== undefined ? { reference: outcome.resultLabel } : {}),
        },
        displayText: sentDisplayText(destination, outcome.resultLabel, options.verbKey),
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
      return failedResult(
        outcome.errorCode,
        outcome.message,
        options.connectorId,
        userEdits(outcome)
      );
    case "unknown":
      return {
        success: true,
        data: {
          status: "unknown",
          destination,
          checkUrl: outcome.checkUrl,
          ...userEdits(outcome),
          guidance: `It may or may not have been sent. ${NO_RETRY} ${
            options.unknownGuidance ?? `Tell the user to check ${destination}.`
          }`,
        },
        displayText: unknownDisplayText(destination, options.connectorId, options.verbKey),
      };
  }
}
