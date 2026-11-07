import { useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown, Search } from "../icons";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { cn } from "../lib/utils";
import type { ConnectorDestination } from "../../types/connectors";
import { useCallCardPlacement } from "./callCardContext";

const MENU_ITEM =
  "flex w-full items-center justify-between gap-3 rounded-lg px-2.5 py-1.5 text-start text-[13px] text-foreground transition-colors hover:bg-foreground/5 focus:outline-none focus-visible:bg-foreground/5 agent:text-[14px]";
const MENU_NOTE = "px-2.5 py-1.5 text-[13px] text-muted-foreground agent:text-[14px]";

/**
 * A Slack channel post's Channel, as a menu of the channels its Slack login
 * is in, with a search. Main reads them for the card's pending action, so
 * never another login's; a pick only changes the draft, and main checks it
 * again at Send. In a call it is a field, and its menu marks the channel picked.
 */
export function SlackChannelPicker({
  actionId,
  selectedId,
  label,
  onPick,
}: {
  actionId: string;
  selectedId: string;
  label: string;
  onPick: (channel: ConnectorDestination) => void;
}): ReactElement {
  const { t } = useTranslation();
  const inCall = useCallCardPlacement() !== null;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  // Null until main answers; "failed" when it couldn't read them.
  const [channels, setChannels] = useState<ConnectorDestination[] | "failed" | null>(null);

  useEffect(() => {
    if (!open) return;
    let current = true;
    const settle = (next: ConnectorDestination[] | "failed") => {
      if (current) setChannels(next);
    };
    Promise.resolve(window.electronAPI?.connectorDestinations?.(actionId))
      .then((result) => settle(result?.status === "ok" ? result.destinations : "failed"))
      .catch(() => settle("failed"));
    return () => {
      current = false;
    };
  }, [open, actionId]);

  const changeOpen = (next: boolean): void => {
    setOpen(next);
    if (!next) setQuery("");
  };
  const needle = query.trim().toLocaleLowerCase();
  const matches = Array.isArray(channels)
    ? channels.filter((channel) => channel.label.toLocaleLowerCase().includes(needle))
    : [];

  return (
    <Popover open={open} onOpenChange={changeOpen}>
      <PopoverTrigger
        data-approval-field="channel"
        className={cn(
          "-mx-1 flex min-w-0 items-center gap-1.5 rounded-md px-1 py-0.5 text-foreground transition-colors hover:bg-foreground/5 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring/40 data-[state=open]:bg-foreground/5",
          inCall &&
            "mx-0 h-7 min-w-40 justify-between justify-self-start rounded-lg bg-surface-2 px-2 hover:bg-surface-raised data-[state=open]:bg-surface-raised"
        )}
      >
        <span className="truncate" dir="auto">
          {label}
        </span>
        <ChevronDown size={14} className="shrink-0 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        collisionPadding={8}
        className={cn(
          // Within the window: in a short one (a call's card) the list scrolls instead.
          "flex max-h-(--radix-popover-content-available-height) w-[260px] min-w-0 flex-col rounded-xl p-1.5",
          inCall && "w-[280px]"
        )}
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <label
          className={cn(
            "mb-1 flex items-center gap-2 rounded-lg bg-surface-1 px-2.5 py-1.5 text-muted-foreground",
            inCall && "bg-surface-2 py-2"
          )}
        >
          <Search size={14} className="shrink-0" />
          <input
            dir="auto"
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("connectors.approval.slack.findChannel")}
            aria-label={t("connectors.approval.slack.findChannel")}
            className="input-inline min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground/70 agent:text-[14px]"
          />
        </label>
        <div
          role="listbox"
          aria-label={t("connectors.approval.slack.channelLabel")}
          className="agent-chat-scroll max-h-56 overflow-y-auto"
        >
          {channels === null && <p className={MENU_NOTE}>{t("common.loading")}</p>}
          {channels === "failed" && (
            <p className={MENU_NOTE}>{t("connectors.approval.slack.channelsUnavailable")}</p>
          )}
          {Array.isArray(channels) && matches.length === 0 && (
            <p className={MENU_NOTE}>{t("connectors.approval.slack.noChannels")}</p>
          )}
          {matches.map((channel) => (
            <button
              key={channel.id}
              type="button"
              role="option"
              aria-selected={channel.id === selectedId}
              onClick={() => {
                onPick(channel);
                changeOpen(false);
              }}
              className={cn(MENU_ITEM, inCall && "min-h-9 aria-selected:bg-foreground/5")}
            >
              <span className="truncate" dir="auto">
                {channel.label}
              </span>
              {channel.id === selectedId && <Check size={14} className="shrink-0" />}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
