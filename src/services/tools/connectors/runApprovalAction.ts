import type { ToolExecutionContext, ToolResult } from "../ToolRegistry";
import { requestApproval } from "../../../stores/connectorApprovalStore";
import { approvalOutcomeResult, prepareFailureResult, unavailableResult } from "./toolOutcome";

/** Prepare in main, show the card, and report what the user decided. */
export async function runApprovalAction(
  context: ToolExecutionContext | undefined,
  connectorId: string,
  action: string,
  args: Record<string, unknown>
): Promise<ToolResult> {
  if (!context) return unavailableResult("no_chat_context");
  const prepared = await window.electronAPI?.connectorPrepare?.(connectorId, action, args);
  if (!prepared) return unavailableResult("connectors_unavailable");
  if (prepared.status !== "ready") return prepareFailureResult(prepared);

  const outcome = await requestApproval(context, {
    actionId: prepared.actionId,
    connectorId,
    preview: prepared.preview,
  });
  return approvalOutcomeResult(outcome, prepared.preview.destinationLabel);
}
