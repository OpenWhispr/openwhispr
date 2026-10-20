import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown, GitFork, Minimize, Plus } from "../icons";
import { cn } from "../lib/utils";
import { BrandMarkIcon } from "../dictation/BrandMarkIcon";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import type { ConversationPreview } from "../../types/electron";

const CHAT_LIST_LIMIT = 50;

const HEADER_BUTTON =
  "flex size-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring/40 disabled:opacity-40";

// The New chat and chat-switcher pair, set close together in one chip.
const CHIP_BUTTON =
  "flex h-full items-center rounded-full px-0.5 text-muted-foreground transition-colors hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring/40";

/** The chats to switch to, forks marked; listed fresh each time it opens. */
function ChatSwitcher({
  activeConversationId,
  onSelect,
}: {
  activeConversationId: number | null;
  onSelect: (conversationId: number) => void;
}) {
  const { t } = useTranslation();
  const [chats, setChats] = useState<ConversationPreview[] | null>(null);

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (!open) return;
        void window.electronAPI
          ?.getAgentConversationsWithPreview?.(CHAT_LIST_LIMIT, 0, false)
          .then((list) => setChats(list ?? []))
          .catch(() => setChats([]));
      }}
    >
      <DropdownMenuTrigger
        aria-label={t("agentWindow.chats.switch")}
        title={t("agentWindow.chats.switch")}
        className={CHIP_BUTTON}
      >
        <ChevronDown size={12} />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="agent-chat-scroll max-h-72 w-64 overflow-y-auto"
      >
        <DropdownMenuLabel className="text-xs text-muted-foreground">
          {t("agentWindow.chats.title")}
        </DropdownMenuLabel>
        {chats?.length === 0 && (
          <p className="px-2 py-1.5 text-xs text-muted-foreground">
            {t("agentWindow.chats.empty")}
          </p>
        )}
        {chats?.map((chat) => (
          <DropdownMenuItem
            key={chat.id}
            onSelect={() => onSelect(chat.id)}
            className="flex items-center gap-2"
          >
            {chat.parent_conversation_id != null && (
              <GitFork
                size={12}
                role="img"
                aria-label={t("agentWindow.chats.fork")}
                className="shrink-0 text-muted-foreground"
              />
            )}
            <span dir="auto" className="flex-1 truncate">
              {chat.title || t("agentWindow.chats.untitled")}
            </span>
            {chat.id === activeConversationId && <Check size={13} className="shrink-0" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export type AgentModalGlow = "strong" | "soft" | "none";

interface AgentModalProps {
  /** The empty voice state shows no title, and collapses with a chevron. */
  bare: boolean;
  glow: AgentModalGlow;
  conversationId: number | null;
  onNewChat: () => void;
  onSelectChat: (conversationId: number) => void;
  onCollapse: () => void;
  children: ReactNode;
  /** The composer or the pill, docked at the bottom. */
  footer: ReactNode;
}

/** The expanded assistant: chat controls and title, the conversation, and the input docked below. */
export function AgentModal({
  bare,
  glow,
  conversationId,
  onNewChat,
  onSelectChat,
  onCollapse,
  children,
  footer,
}: AgentModalProps) {
  const { t } = useTranslation();
  return (
    <div className="agent-modal relative flex h-full w-full flex-col overflow-hidden rounded-3xl border border-border bg-surface-0 shadow-[var(--shadow-modal)]">
      <div
        data-glow={glow}
        className="agent-modal-glow pointer-events-none absolute inset-x-0 bottom-0 h-1/2"
      />
      <header className="relative grid h-14 shrink-0 grid-cols-[1fr_auto_1fr] items-center px-3">
        <div className="flex h-7.5 items-center gap-0.5 justify-self-start rounded-full border border-border bg-surface-1 px-1">
          <button
            type="button"
            onClick={onNewChat}
            aria-label={t("agentWindow.chats.new")}
            title={t("agentWindow.chats.new")}
            className={CHIP_BUTTON}
          >
            <Plus size={14} />
          </button>
          <ChatSwitcher activeConversationId={conversationId} onSelect={onSelectChat} />
        </div>
        {!bare && (
          <div className="flex items-center gap-2 text-[15px] text-muted-foreground">
            <BrandMarkIcon size={18} />
            {t("agentWindow.title")}
          </div>
        )}
        <button
          type="button"
          onClick={onCollapse}
          aria-label={t("agentWindow.actions.collapse")}
          title={t("agentWindow.actions.collapse")}
          className={cn(HEADER_BUTTON, "col-start-3 justify-self-end")}
        >
          {bare ? <ChevronDown size={16} /> : <Minimize size={15} />}
        </button>
      </header>
      <div className="relative flex min-h-0 flex-1 flex-col">{children}</div>
      <div className="relative shrink-0 px-3 pb-3">{footer}</div>
    </div>
  );
}
