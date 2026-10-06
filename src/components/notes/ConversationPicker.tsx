import { ChevronDown, Clock, PanelRightClose, Plus } from "../icons";
import { useTranslation } from "react-i18next";
import { useUiLocale } from "../../hooks/useUiLocale";
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
  variant?: "default" | "sidebar";
  onUndock?: () => void;
}

export function ConversationPicker({
  conversations,
  activeConversationId,
  onSwitchConversation,
  onNewChat,
  titleClassName,
  variant = "default",
  onUndock,
}: ConversationPickerProps) {
  const { t } = useTranslation();
  const locale = useUiLocale();
  const activeConversation = conversations.find((item) => item.id === activeConversationId);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className={cn(
            "inline-flex items-center rounded-md transition-colors duration-150 outline-none hover:bg-foreground/5",
            variant === "sidebar"
              ? "gap-2 px-1 py-1 text-sm text-foreground/65 hover:text-foreground"
              : "-ms-1.5 gap-1 px-1.5 py-0.5 text-xs font-medium text-foreground/50 hover:text-foreground/70"
          )}
          aria-label={t("embeddedChat.conversationSelector")}
        >
          {variant === "sidebar" && <Clock size={18} className="shrink-0" />}
          <span className={cn("truncate max-w-40", titleClassName)}>
            {variant === "sidebar"
              ? t("embeddedChat.history")
              : activeConversation?.title || t("embeddedChat.newChat")}
          </span>
          {variant !== "sidebar" && (
            <ChevronDown size={10} className="shrink-0 text-foreground/45" />
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={4} className="min-w-44 max-w-56 p-1">
        <DropdownMenuItem onClick={onNewChat} className="text-xs gap-2 rounded-md px-2 py-1.5">
          <Plus size={10} className="text-foreground/45 shrink-0" />
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
                <span className="text-[10px] text-foreground/45 shrink-0">
                  {formatShortDate(conversation.updated_at, locale)}
                </span>
              </DropdownMenuItem>
            ))}
          </>
        )}
        {onUndock && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onUndock} className="text-xs gap-2 rounded-md px-2 py-1.5">
              <PanelRightClose size={12} className="text-foreground/45 shrink-0" />
              {t("embeddedChat.undock")}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
