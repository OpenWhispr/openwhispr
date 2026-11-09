import { useChatTurnStore } from "../../stores/chatTurnStore";
import { useAgentInteractionStore } from "../../stores/agentInteractionStore";
import { useConnectorApprovalStore } from "../../stores/connectorApprovalStore";
import { useSkillApprovalStore } from "../../stores/skillApprovalStore";
import { findPendingCard } from "../agent/agentWindowState";

/** A main chat turn waits on the user's answer to one of its cards, wherever the user is now. */
export function useChatNeedsAttention(): boolean {
  const interactions = useAgentInteractionStore((store) => store.entries);
  const approvals = useConnectorApprovalStore((store) => store.entries);
  const skillApprovals = useSkillApprovalStore((store) => store.entries);
  return useChatTurnStore((state) =>
    Object.values(state.entries).some(
      (entry) =>
        entry.running &&
        (findPendingCard(entry.messages, interactions, {}, { includeRestored: true }) !== null ||
          findPendingCard(entry.messages, {}, approvals) !== null ||
          findPendingCard(entry.messages, {}, {}, { skillApprovals }) !== null)
    )
  );
}
