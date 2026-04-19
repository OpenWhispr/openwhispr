import { useTranslation } from "react-i18next";
import { ChatMessages } from "../chat/ChatMessages";
import { ChatEmptyIllustration } from "../chat/ChatEmptyIllustration";
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
        <div className="flex flex-col items-center justify-center h-full -mt-4 select-none">
          <ChatEmptyIllustration size={48} />
          <p className="text-xs text-foreground/50 dark:text-foreground/25 mt-3">
            {t("agentMode.chat.emptyState")}
          </p>
        </div>
      }
    />
  );
}
