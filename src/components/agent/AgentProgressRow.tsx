import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Brain, ChevronRight, Search } from "../icons";
import { cn } from "../lib/utils";
import { toolIcons } from "../chat/toolIcons";
import { toolCallStepText, visibleToolCalls } from "../chat/toolCallText";
import type { Message } from "../chat/types";
import githubMark from "../../assets/icons/github.svg";
import linearMark from "../../assets/icons/linear.svg";
import slackMark from "../../assets/icons/slack.svg";

// A connector's own tools show its app's logo, by the tool-name prefix.
const APP_LOGOS: Record<string, { src: string; monochrome: boolean }> = {
  slack: { src: slackMark, monochrome: false },
  linear: { src: linearMark, monochrome: true },
  github: { src: githubMark, monochrome: true },
};
const MAX_GROUPED_ICONS = 3;

function ToolMark({ name, size = 14 }: { name: string; size?: number }) {
  const logo = APP_LOGOS[name.split("_")[0]];
  if (logo) {
    return (
      <img
        src={logo.src}
        alt=""
        aria-hidden="true"
        width={size}
        height={size}
        draggable={false}
        decoding="async"
        className={cn("shrink-0", logo.monochrome && "icon-monochrome")}
        style={{ width: size, height: size }}
      />
    );
  }
  const Icon = toolIcons[name] ?? Search;
  return <Icon size={size} className="shrink-0" />;
}

function formatDuration(ms: number, locale: string): string {
  const totalSeconds = Math.max(1, Math.round(ms / 1000));
  const unit = (value: number, name: "second" | "minute") =>
    new Intl.NumberFormat(locale, { style: "unit", unit: name, unitDisplay: "narrow" }).format(
      value
    );
  if (totalSeconds < 60) return unit(totalSeconds, "second");
  const seconds = totalSeconds % 60;
  const minutes = unit(Math.floor(totalSeconds / 60), "minute");
  return seconds ? `${minutes} ${unit(seconds, "second")}` : minutes;
}

/**
 * What a reply is doing, then what it did: one compact row that expands into
 * its steps. While it runs: thinking, reasoning, the tool it is calling (or
 * how many), then checking what they returned. Once done: how long it took
 * and how many steps.
 */
export function AgentProgressRow({ message }: { message: Message }) {
  const { t, i18n } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const turnStart = message.turn?.startedAt;
  // A regenerated reply keeps the sends its earlier turn made; they aren't its steps.
  const steps = visibleToolCalls(message.toolCalls).filter(
    (step) => turnStart == null || step.startedAt == null || step.startedAt >= turnStart
  );
  const reasoning = message.turn?.reasoning;
  const running = message.isStreaming;
  const executing = steps.filter((step) => step.status === "executing");

  let icon: React.ReactNode = null;
  let label: string;
  let active = running;
  if (running && executing.length > 1) {
    icon = (
      <span className="flex -space-x-1">
        {executing.slice(0, MAX_GROUPED_ICONS).map((step) => (
          <span
            key={step.id}
            className="flex size-[18px] items-center justify-center rounded-full border border-surface-0 bg-surface-2"
          >
            <ToolMark name={step.name} size={11} />
          </span>
        ))}
      </span>
    );
    label = t("agentWindow.progress.callingTools", { count: executing.length });
  } else if (running && executing.length === 1) {
    icon = <ToolMark name={executing[0].name} />;
    label = toolCallStepText(executing[0], t);
  } else if (running && !message.content) {
    if (steps.length > 0) label = t("agentWindow.progress.checkingAnswers");
    else if (reasoning) {
      icon = <Brain size={14} className="shrink-0" />;
      label = t("agentWindow.progress.reasoning");
    } else label = t("agentMode.input.thinking");
  } else {
    if (!steps.length && !reasoning) return null;
    active = false;
    // A turn saved while it waited, and never finished, has no length to show.
    const finishedAt = message.turn?.finishedAt;
    const duration =
      turnStart != null && finishedAt != null
        ? formatDuration(finishedAt - turnStart, i18n.language)
        : null;
    const parts = [
      duration &&
        t(reasoning ? "agentWindow.progress.reasonedFor" : "agentWindow.progress.workedFor", {
          duration,
        }),
      steps.length > 0 && t("agentWindow.progress.steps", { count: steps.length }),
    ].filter(Boolean);
    icon = <Brain size={14} className="shrink-0" />;
    label = parts.join(" · ") || t("agentMode.turn.reasoning");
  }

  const expandable = steps.length > 0 || Boolean(reasoning);

  return (
    <div className="text-[13px] text-muted-foreground">
      <button
        type="button"
        disabled={!expandable}
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expandable ? expanded : undefined}
        className="flex max-w-full items-center gap-2 rounded-md py-0.5 text-start transition-colors hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring/40 disabled:cursor-default disabled:hover:text-muted-foreground"
      >
        {icon}
        <span className={cn("truncate", active && "thinking-shimmer-text")}>{label}</span>
        {expandable && (
          <ChevronRight
            size={13}
            className={cn("shrink-0 transition-transform rtl:rotate-180", expanded && "rotate-90")}
          />
        )}
      </button>
      {expanded && (
        <div className="ms-[7px] mt-1.5 flex flex-col gap-2 border-s border-border/70 ps-3.5">
          {reasoning && (
            <p
              dir="auto"
              className="whitespace-pre-wrap text-[12px] leading-5 text-muted-foreground/80"
            >
              {reasoning}
            </p>
          )}
          {steps.map((step) => (
            <div
              key={step.id}
              className={cn(
                "flex min-w-0 items-center gap-2",
                step.status === "error" && "text-destructive/80"
              )}
            >
              <ToolMark name={step.name} />
              <span dir="auto" className="truncate">
                {toolCallStepText(step, t).split("\n")[0]}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
