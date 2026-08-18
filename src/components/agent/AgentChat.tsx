import { MessagesSquare } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ChatMessages } from "../chat/ChatMessages";
import { EmptyState } from "../ui/EmptyState";
import type { Message } from "../chat/types";

export type { Message, ToolCallInfo } from "../chat/types";

interface AgentChatProps {
  messages: Message[];
}

export function AgentChat({ messages }: AgentChatProps) {
  const { t } = useTranslation();

  return (
    <ChatMessages
      messages={messages}
      emptyState={
        <EmptyState
          compact
          icon={MessagesSquare}
          description={t("agentMode.chat.emptyState")}
          className="h-full -mt-4 select-none"
        />
      }
    />
  );
}
