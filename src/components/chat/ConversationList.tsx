import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { SquarePen, Search, Archive as ArchiveIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn } from "../lib/utils";
import { normalizeDbDate } from "../../utils/dateFormatting";
import ConversationItem, { type ConversationPreview } from "./ConversationItem";
import ConversationDateGroup from "./ConversationDateGroup";
import EmptyConversationList from "./EmptyConversationList";

type FlatItem =
  | { type: "header"; label: string }
  | { type: "conversation"; data: ConversationPreview };

interface ConversationListProps {
  activeConversationId: number | null;
  onSelectConversation: (id: number) => void;
  onNewChat: () => void;
  onOpenSearch: () => void;
  onArchive: (id: number) => void;
  onDelete: (id: number) => void;
  refreshKey: number;
}

function groupByDate(conversations: ConversationPreview[], t: (key: string) => string): FlatItem[] {
  if (conversations.length === 0) return [];

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const weekAgo = new Date(today);
  weekAgo.setDate(weekAgo.getDate() - 7);

  const items: FlatItem[] = [];
  let currentGroup: string | null = null;

  for (const conv of conversations) {
    const date = normalizeDbDate(conv.updated_at);
    const target = new Date(date.getFullYear(), date.getMonth(), date.getDate());

    let group: string;
    if (target.getTime() >= today.getTime()) {
      group = t("chat.today");
    } else if (target.getTime() >= yesterday.getTime()) {
      group = t("chat.yesterday");
    } else if (target.getTime() >= weekAgo.getTime()) {
      group = t("chat.previousWeek");
    } else {
      group = t("chat.older");
    }

    if (group !== currentGroup) {
      items.push({ type: "header", label: group });
      currentGroup = group;
    }
    items.push({ type: "conversation", data: conv });
  }

  return items;
}

function SkeletonRows() {
  return (
    <div className="px-3 pt-4 space-y-3">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="space-y-1.5">
          <div
            className="h-3 rounded bg-foreground/5"
            style={{
              width: `${60 + i * 10}%`,
              animation: `tool-status-sweep 1.5s ease-in-out ${i * 0.15}s infinite`,
              backgroundSize: "200% 100%",
              background: "linear-gradient(90deg, transparent, oklch(0.5 0 0 / 0.06), transparent)",
            }}
          />
          <div
            className="h-2.5 rounded bg-foreground/3"
            style={{
              width: `${80 + (i % 2) * 10}%`,
              animation: `tool-status-sweep 1.5s ease-in-out ${i * 0.15 + 0.08}s infinite`,
              backgroundSize: "200% 100%",
              background: "linear-gradient(90deg, transparent, oklch(0.5 0 0 / 0.04), transparent)",
            }}
          />
        </div>
      ))}
    </div>
  );
}

export default function ConversationList({
  activeConversationId,
  onSelectConversation,
  onNewChat,
  onOpenSearch,
  onArchive,
  onDelete,
  refreshKey,
}: ConversationListProps) {
  const { t } = useTranslation();
  const [conversations, setConversations] = useState<ConversationPreview[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showArchived, setShowArchived] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const showSkeletonTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [showSkeleton, setShowSkeleton] = useState(false);

  const loadConversations = useCallback(async () => {
    try {
      const [active, archived] = await Promise.all([
        window.electronAPI?.getAgentConversationsWithPreview?.(200, 0, false),
        window.electronAPI?.getAgentConversationsWithPreview?.(200, 0, true),
      ]);
      const toPreview = (c: {
        id: number;
        title: string;
        last_message?: string;
        created_at: string;
        updated_at: string;
        archived_at?: string;
      }) => ({
        id: c.id,
        title: c.title || "Untitled",
        preview: c.last_message,
        created_at: c.created_at,
        updated_at: c.updated_at,
        is_archived: !!c.archived_at,
      });
      setConversations([...(active ?? []).map(toPreview), ...(archived ?? []).map(toPreview)]);
    } catch {
      // silently fail
    } finally {
      setIsLoading(false);
      setShowSkeleton(false);
      if (showSkeletonTimer.current) {
        clearTimeout(showSkeletonTimer.current);
        showSkeletonTimer.current = null;
      }
    }
  }, []);

  useEffect(() => {
    setIsLoading(true);
    showSkeletonTimer.current = setTimeout(() => setShowSkeleton(true), 150);
    loadConversations();
    return () => {
      if (showSkeletonTimer.current) clearTimeout(showSkeletonTimer.current);
    };
  }, [loadConversations, refreshKey]);

  const filtered = useMemo(() => {
    return showArchived
      ? conversations.filter((c) => c.is_archived)
      : conversations.filter((c) => !c.is_archived);
  }, [conversations, showArchived]);

  const flatItems = useMemo(() => groupByDate(filtered, t), [filtered, t]);

  const virtualizer = useVirtualizer({
    count: flatItems.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => (flatItems[index].type === "header" ? 28 : 52),
    overscan: 5,
  });

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (flatItems.length === 0) return;

      const convItems = flatItems
        .map((item, index) => ({ item, index }))
        .filter((entry) => entry.item.type === "conversation");
      if (convItems.length === 0) return;

      const currentIdx = convItems.findIndex(
        (entry) => entry.item.type === "conversation" && entry.item.data.id === activeConversationId
      );

      if (e.key === "ArrowDown") {
        e.preventDefault();
        const next = currentIdx < convItems.length - 1 ? currentIdx + 1 : 0;
        const item = convItems[next].item;
        if (item.type === "conversation") onSelectConversation(item.data.id);
        virtualizer.scrollToIndex(convItems[next].index);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        const prev = currentIdx > 0 ? currentIdx - 1 : convItems.length - 1;
        const item = convItems[prev].item;
        if (item.type === "conversation") onSelectConversation(item.data.id);
        virtualizer.scrollToIndex(convItems[prev].index);
      } else if (e.key === "Enter" && activeConversationId) {
        e.preventDefault();
      }
    },
    [flatItems, activeConversationId, onSelectConversation, virtualizer]
  );

  if (isLoading && showSkeleton) {
    return (
      <div className="flex flex-col h-full">
        <div className="px-2 pt-2 pb-1 flex items-center gap-1.5">
          <h2 className="text-xs font-medium text-foreground px-1 flex-1">{t("sidebar.chat")}</h2>
        </div>
        <SkeletonRows />
      </div>
    );
  }

  if (isLoading && !showSkeleton) {
    return (
      <div className="flex flex-col h-full">
        <div className="px-2 pt-2 pb-1 flex items-center gap-1.5">
          <h2 className="text-xs font-medium text-foreground px-1 flex-1">{t("sidebar.chat")}</h2>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full" onKeyDown={handleKeyDown} tabIndex={-1}>
      <div className="px-2 pt-2 pb-1 shrink-0 space-y-0.5">
        <button
          onClick={onNewChat}
          className={cn(
            "flex items-center gap-2 w-full px-2 py-1.5 rounded-md text-xs",
            "text-muted-foreground/80 hover:text-foreground hover:bg-foreground/5",
            "transition-colors duration-150",
            "focus:outline-none focus-visible:ring-1 focus-visible:ring-ring/30"
          )}
        >
          <SquarePen size={14} className="shrink-0" />
          {t("chat.newChat")}
        </button>
        <button
          onClick={onOpenSearch}
          className={cn(
            "flex items-center gap-2 w-full px-2 py-1.5 rounded-md text-xs",
            "text-muted-foreground/80 hover:text-foreground hover:bg-foreground/5",
            "transition-colors duration-150",
            "focus:outline-none focus-visible:ring-1 focus-visible:ring-ring/30"
          )}
        >
          <Search size={14} className="shrink-0" />
          {t("chat.searchChats")}
        </button>
        {conversations.some((c) => c.is_archived) && (
          <button
            onClick={() => setShowArchived((v) => !v)}
            className={cn(
              "flex items-center gap-2 w-full px-2 py-1.5 rounded-md text-xs transition-colors duration-150",
              "focus:outline-none focus-visible:ring-1 focus-visible:ring-primary/30",
              showArchived
                ? "bg-primary/8 text-primary"
                : "text-muted-foreground/80 hover:text-foreground hover:bg-foreground/5"
            )}
          >
            <ArchiveIcon size={14} className="shrink-0" />
            {t("chat.archived")}
          </button>
        )}
      </div>

      {flatItems.length === 0 ? (
        <EmptyConversationList onNewChat={onNewChat} />
      ) : (
        <div ref={scrollRef} className="flex-1 overflow-y-auto">
          <div
            style={{
              height: `${virtualizer.getTotalSize()}px`,
              width: "100%",
              position: "relative",
            }}
          >
            {virtualizer.getVirtualItems().map((virtualItem) => {
              const item = flatItems[virtualItem.index];
              return (
                <div
                  key={virtualItem.key}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    height: `${virtualItem.size}px`,
                    transform: `translateY(${virtualItem.start}px)`,
                  }}
                >
                  {item.type === "header" ? (
                    <ConversationDateGroup label={item.label} />
                  ) : (
                    <ConversationItem
                      conversation={item.data}
                      isActive={item.data.id === activeConversationId}
                      onClick={() => onSelectConversation(item.data.id)}
                      onArchive={onArchive}
                      onDelete={onDelete}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
