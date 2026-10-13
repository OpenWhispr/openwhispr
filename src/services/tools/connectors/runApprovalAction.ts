import i18n from "../../../i18n";
import type { ToolExecutionContext, ToolResult } from "../ToolRegistry";
import { requestApproval } from "../../../stores/connectorApprovalStore";
import {
  approvalOutcomeResult,
  notSentResult,
  prepareFailureResult,
  unavailableResult,
} from "./toolOutcome";

/**
 * Cards one turn can raise, across every connector. "File these eight action
 * items as issues" gets five now and the rest on request; a model stuck in a
 * loop, or following injected text, can't bury the panel in cards.
 */
export const MAX_APPROVAL_CARDS_PER_TURN = 5;
const CARD_SLOT = "approval_card";
// The model reads this only once every card of the step is settled, so it
// reports outcomes rather than pointing at cards still waiting.
const CARD_LIMIT_GUIDANCE = `Only ${MAX_APPROVAL_CARDS_PER_TURN} approval cards can be prepared per request. Tell the user how the prepared ones turned out, and offer to prepare the rest in a new request.`;

/**
 * Prepare in main, show the card, and report what the user decided.
 * `unknownGuidance` tells the model where the user can check a send that
 * may or may not have gone out (Gmail: the Sent folder).
 */
export async function runApprovalAction(
  context: ToolExecutionContext | undefined,
  connectorId: string,
  action: string,
  args: Record<string, unknown>,
  options: { unknownGuidance?: string } = {}
): Promise<ToolResult> {
  if (!context) return unavailableResult("no_chat_context");
  // Whatever happens next (a card, a question, a refusal), the answer belongs
  // in the panel: a voice turn must never paste it at the caret.
  context.onHoldDelivery();
  // Claimed before the first await, so calls running in parallel can't overshoot.
  if (!context.claimTurnSlot(CARD_SLOT, MAX_APPROVAL_CARDS_PER_TURN)) {
    return notSentResult(
      "card_limit",
      CARD_LIMIT_GUIDANCE,
      i18n.t("connectors.toolStatus.cardLimit", { max: MAX_APPROVAL_CARDS_PER_TURN })
    );
  }
  // A rejected IPC call reads as unavailable, so the caller's turn slot is
  // given back and the model is told not to retry.
  const prepared = await window.electronAPI
    ?.connectorPrepare?.(connectorId, action, args)
    .catch(() => undefined);
  // No card appeared, so the slot goes back for another try this turn.
  if (!prepared) {
    context.releaseTurnSlot(CARD_SLOT);
    return unavailableResult("connectors_unavailable");
  }
  if (prepared.status !== "ready") {
    context.releaseTurnSlot(CARD_SLOT);
    return prepareFailureResult(prepared, connectorId);
  }

  const outcome = await requestApproval(context, {
    actionId: prepared.actionId,
    connectorId,
    preview: prepared.preview,
  });
  // An edited card may have gone to other recipients than the model chose.
  const destination =
    (outcome.state === "sent" || outcome.state === "unknown") && outcome.destinationLabel
      ? outcome.destinationLabel
      : prepared.preview.destinationLabel;
  return approvalOutcomeResult(outcome, destination, {
    ...options,
    connectorId,
    verbKey: prepared.preview.verbKey,
  });
}
