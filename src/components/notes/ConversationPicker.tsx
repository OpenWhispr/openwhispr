import { ChevronDown, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ContainerConversationItem } from "../../hooks/useContainerChat";
import { formatShortDate } from "../../utils/dateFormatting";
import { cn } from "../lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";

interface ConversationPickerProps {
  conversations: ContainerConversationItem[];
  activeConversationId?: number | null;
  onSwitchConversation: (id: number) => void;
  onNewChat?: () => void;
  titleClassName?: string;
}

export function ConversationPicker({
  conversations,
  activeConversationId,
  onSwitchConversation,
  onNewChat,
  titleClassName,
}: ConversationPickerProps) {
  const { t } = useTranslation();
  const activeConversation = conversations.find((item) => item.id === activeConversationId);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className="inline-flex items-center gap-1 text-xs font-medium text-foreground/50 hover:text-foreground/70 hover:bg-foreground/5 rounded-md px-1.5 py-0.5 -ml-1.5 transition-colors duration-150 outline-none"
          aria-label={t("embeddedChat.conversationSelector")}
        >
          <span className={cn("truncate max-w-40", titleClassName)}>
            {activeConversation?.title || t("embeddedChat.newChat")}
          </span>
          <ChevronDown size={10} className="shrink-0 text-foreground/30" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={4} className="min-w-44 max-w-56 p-1">
        <DropdownMenuItem onClick={onNewChat} className="text-xs gap-2 rounded-md px-2 py-1.5">
          <Plus size={10} className="text-foreground/40 shrink-0" />
          {t("embeddedChat.newChat")}
        </DropdownMenuItem>
        {conversations.length > 0 && (
          <>
            <DropdownMenuSeparator />
            {conversations.map((conversation) => (
              <DropdownMenuItem
                key={conversation.id}
                onClick={() => onSwitchConversation(conversation.id)}
                className={cn(
                  "text-xs gap-2 rounded-md px-2 py-1.5",
                  conversation.id === activeConversationId && "bg-foreground/4"
                )}
              >
                <span className="truncate flex-1">{conversation.title}</span>
                <span className="text-[10px] text-foreground/30 shrink-0">
                  {formatShortDate(conversation.updated_at)}
                </span>
              </DropdownMenuItem>
            ))}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
