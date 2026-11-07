import i18n from "../../../i18n";
import type { ToolExecutionContext, ToolResult } from "../ToolRegistry";
import type { ConnectorPrepareResult } from "../../../types/connectors";
import {
  approvalKey,
  requestApproval,
  useConnectorApprovalStore,
} from "../../../stores/connectorApprovalStore";
import {
  duplicateActionResult,
  approvalOutcomeResult,
  notSentResult,
  prepareFailureResult,
  unavailableResult,
} from "./toolOutcome";
import { approvalActionKey, connectorActionKey } from "./actionKey";

/**
 * Cards one turn can raise, across every connector. "File these eight action
 * items as issues" gets five now and the rest on request; a model stuck in a
 * loop, or following injected text, can't bury the chat in cards.
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
  // Claim before preparing a card: a concurrent call or a completed action in
  // this request may already hold this key.
  const actionKey = connectorActionKey(connectorId, action, args);
  if (!context.claimAction(actionKey)) return duplicateActionResult();
  // Claimed before the first await, so calls running in parallel can't overshoot.
  if (!context.claimTurnSlot(CARD_SLOT, MAX_APPROVAL_CARDS_PER_TURN)) {
    context.releaseAction(actionKey);
    return notSentResult(
      "card_limit",
      CARD_LIMIT_GUIDANCE,
      i18n.t("connectors.toolStatus.cardLimit", { max: MAX_APPROVAL_CARDS_PER_TURN })
    );
  }
  // The same send in an earlier request may be wanted again; the card says so
  // and the user's Send decides. A rejected IPC call reads as unavailable.
  const prepare = async (): Promise<ConnectorPrepareResult | undefined> => {
    const result = await window.electronAPI
      ?.connectorPrepare?.(connectorId, action, args)
      .catch(() => undefined);
    if (
      result?.status !== "ready" ||
      (!context.sentEarlier(actionKey) &&
        !context.sentEarlier(approvalActionKey(connectorId, action, args, result.preview)))
    )
      return result;
    const { preview } = result;
    const notes = [...(preview.notes ?? []), { key: "connectors.approval.sentEarlier" }];
    return { ...result, preview: { ...preview, notes } };
  };
  const prepared = await prepare();
  // No card appeared, so the slot goes back for another try this turn.
  if (!prepared) {
    context.releaseTurnSlot(CARD_SLOT);
    context.releaseAction(actionKey);
    return unavailableResult("connectors_unavailable");
  }
  if (prepared.status !== "ready") {
    context.releaseTurnSlot(CARD_SLOT);
    context.releaseAction(actionKey);
    return prepareFailureResult(prepared, connectorId);
  }
  const preparedKey = approvalActionKey(connectorId, action, args, prepared.preview);
  if (preparedKey !== actionKey && !context.claimAction(preparedKey)) {
    void window.electronAPI?.connectorCancel?.(prepared.actionId, "cancelled_by_user");
    context.releaseAction(actionKey);
    context.releaseTurnSlot(CARD_SLOT);
    return duplicateActionResult();
  }

  // Retry and a reconnect prepare the same action again while the tool
  // still waits, so it stays this one send.
  const outcome = await requestApproval(
    context,
    { actionId: prepared.actionId, connectorId, preview: prepared.preview },
    prepare
  );
  context.releaseAction(actionKey);
  if (preparedKey !== actionKey) context.releaseAction(preparedKey);
  if (outcome.state === "sent" || outcome.state === "unknown") {
    const card =
      useConnectorApprovalStore.getState().entries[
        approvalKey(context.messageId, context.toolCallId)
      ];
    const completedKey = approvalActionKey(
      connectorId,
      action,
      args,
      card?.preview ?? prepared.preview,
      card?.draft.fields ?? (card ? { title: card.draft.title, body: card.draft.body } : undefined)
    );
    context.recordCompletedAction(completedKey, {
      status: outcome.state,
      ...(outcome.state === "sent"
        ? {
            ...(outcome.url ? { url: outcome.url } : {}),
            ...(outcome.resultLabel ? { reference: outcome.resultLabel } : {}),
          }
        : {}),
    });
  }
  if (outcome.state === "not_sent" && outcome.clarification) {
    // With what the user wrote on the card, so asking where keeps it.
    return prepareFailureResult(outcome.clarification, connectorId, outcome);
  }
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
