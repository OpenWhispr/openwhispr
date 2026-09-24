import { useCallback } from "react";
import { Sparkles } from "../../icons";
import { useTranslation } from "react-i18next";
import { ChatMessages } from "../../chat/ChatMessages";
import { ChatInput } from "../../chat/ChatInput";
import { observeChatComposerInset } from "../../chat/composerLayout";
import type { Message, AgentState } from "../../chat/types";
import type { ContainerConversationItem } from "../../../hooks/useContainerChat";
import { ConversationPicker } from "../ConversationPicker";

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
  conversations: ContainerConversationItem[];
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
  const composerRef = useCallback((composer: HTMLDivElement | null) => {
    const container = composer?.parentElement?.parentElement;
    if (!composer || !container) return;
    return observeChatComposerInset(composer, container);
  }, []);

  const conversationPicker = (conversations.length > 0 || hasMessages) && (
    <div className="flex items-center pb-2">
      <ConversationPicker
        conversations={conversations}
        activeConversationId={activeConversationId}
        onSwitchConversation={onSwitchConversation}
        onNewChat={onNewChat}
      />
    </div>
  );

  return (
    <div className="relative isolate mx-auto w-full max-w-2xl">
      {conversationPicker}
      {hasMessages && (
        <div className="flex h-[min(26rem,50vh)] min-h-0 flex-col">
          <ChatMessages
            messages={messages}
            onOpenNote={onOpenNote}
            contentClassName="pb-[var(--chat-composer-inset,5rem)]"
          />
        </div>
      )}
      <div className={hasMessages ? "relative h-14" : "relative h-24"}>
        <div ref={composerRef} className="absolute inset-x-0 bottom-0 z-10 py-1">
          {!hasMessages && (
            <div className="scrollbar-hidden flex items-center gap-1.5 overflow-x-auto pb-2">
              {PROMPT_CHIP_KEYS.map((key) => (
                <button
                  key={key}
                  onClick={() => onTextSubmit(t(key))}
                  disabled={agentState !== "idle"}
                  className="inline-flex shrink-0 items-center gap-1.5 px-2.5 h-7 whitespace-nowrap rounded-full border border-border/70 bg-card shadow-sm dark:border-white/10 text-[11px] text-foreground/55 hover:text-foreground/80 hover:border-border/70 hover:bg-surface-3 disabled:text-foreground/30 disabled:pointer-events-none transition-colors duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring/30"
                >
                  <Sparkles size={10} className="text-foreground/45 shrink-0" />
                  {t(key)}
                </button>
              ))}
            </div>
          )}
          <ChatInput
            className="w-full"
            agentState={agentState}
            partialTranscript=""
            onTextSubmit={onTextSubmit}
            onCancel={onCancel}
            focusOnIdle={false}
            expandOnFocus
            expandOnFocusSize="compact"
            variant="assistant"
            placeholder={t("notes.overview.ask.placeholder")}
          />
        </div>
      </div>
    </div>
  );
}
