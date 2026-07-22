import { ChevronDown, Plus, Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/utils";
import { ChatMessages } from "../../chat/ChatMessages";
import { ChatInput } from "../../chat/ChatInput";
import type { Message, AgentState } from "../../chat/types";
import { formatShortDate } from "../../../utils/dateFormatting";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "../../ui/dropdown-menu";

const PROMPT_CHIP_KEYS = [
  "notes.overview.ask.chips.catchUp",
  "notes.overview.ask.chips.keyDecisions",
  "notes.overview.ask.chips.inFlight",
] as const;

interface OverviewAskSectionProps {
  messages: Message[];
  agentState: AgentState;
  onTextSubmit: (text: string) => void;
  onCancel: () => void;
  conversations: Array<{
    id: number;
    title: string;
    created_at: string;
    updated_at: string;
    message_count: number;
  }>;
  activeConversationId: number | null;
  onSwitchConversation: (id: number) => void;
  onNewChat: () => void;
  onOpenNote: (noteId: number) => void;
}

export function OverviewAskSection({
  messages,
  agentState,
  onTextSubmit,
  onCancel,
  conversations,
  activeConversationId,
  onSwitchConversation,
  onNewChat,
  onOpenNote,
}: OverviewAskSectionProps) {
  const { t } = useTranslation();
  const hasMessages = messages.length > 0;
  const activeConversation = conversations.find((c) => c.id === activeConversationId);

  const conversationPicker = (conversations.length > 0 || hasMessages) && (
    <div className="flex items-center px-3 pt-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className="inline-flex items-center gap-1 text-xs font-medium text-foreground/50 hover:text-foreground/70 hover:bg-foreground/5 rounded-md px-1.5 py-0.5 -ml-1.5 transition-colors duration-150 outline-none"
            aria-label={t("embeddedChat.conversationSelector")}
          >
            <span className="truncate max-w-40">
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
              {conversations.map((conv) => (
                <DropdownMenuItem
                  key={conv.id}
                  onClick={() => onSwitchConversation(conv.id)}
                  className={cn(
                    "text-xs gap-2 rounded-md px-2 py-1.5",
                    conv.id === activeConversationId && "bg-foreground/4"
                  )}
                >
                  <span className="truncate flex-1">{conv.title}</span>
                  <span className="text-[10px] text-foreground/30 shrink-0">
                    {formatShortDate(conv.updated_at)}
                  </span>
                </DropdownMenuItem>
              ))}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );

  return (
    <div className="rounded-xl bg-surface-1/50 dark:bg-white/2 border border-border/25 dark:border-white/6">
      {conversationPicker}
      {hasMessages && (
        <div className="max-h-[min(26rem,50vh)] flex flex-col">
          <ChatMessages messages={messages} onOpenNote={onOpenNote} />
        </div>
      )}
      <ChatInput
        agentState={agentState}
        partialTranscript=""
        onTextSubmit={onTextSubmit}
        onCancel={onCancel}
        placeholder={t("notes.overview.ask.placeholder")}
      />
      {!hasMessages && (
        <div className="flex items-center flex-wrap gap-1.5 px-3 pb-3">
          {PROMPT_CHIP_KEYS.map((key) => (
            <button
              key={key}
              onClick={() => onTextSubmit(t(key))}
              disabled={agentState !== "idle"}
              className="inline-flex items-center gap-1.5 px-2.5 h-7 rounded-md border border-border/40 dark:border-white/8 text-[11px] text-foreground/55 hover:text-foreground/80 hover:border-border/70 hover:bg-foreground/3 dark:hover:bg-white/3 disabled:opacity-50 disabled:pointer-events-none transition-colors duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring/30"
            >
              <Sparkles size={10} className="text-foreground/30 shrink-0" />
              {t(key)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
