import type { ButtonHTMLAttributes, ComponentType, ReactElement, ReactNode } from "react";
import { cn } from "../../lib/utils";
import { Loader2 } from "../../icons";
import { badgeToneClass, bannerToneClass, titleToneClass, type BillingTone } from "./billingTones";

type IconComponent = ComponentType<{ className?: string }>;

export function BillingBlock({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}): ReactElement {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-base font-medium text-foreground">{title}</h3>
      {children}
    </section>
  );
}

export function BillingBox({
  children,
  padded,
}: {
  children: ReactNode;
  padded?: "rows" | "details";
}): ReactElement {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-[10px] bg-surface-1",
        padded === "details" && "px-3 py-2"
      )}
    >
      {children}
    </div>
  );
}

export function BillingRow({ children }: { children: ReactNode }): ReactElement {
  return (
    <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-3.5 first:border-t-0">
      {children}
    </div>
  );
}

export function PlanName({
  icon: Icon,
  name,
  badge,
}: {
  icon: IconComponent;
  name: string;
  badge?: { label: string; tone: BillingTone };
}): ReactElement {
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <Icon className="size-4 shrink-0 text-foreground" />
      <span dir="auto" className="truncate text-base font-medium text-foreground">
        {name}
      </span>
      {badge && (
        <span
          dir="auto"
          className={cn(
            "ms-1.5 shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium",
            badgeToneClass(badge.tone)
          )}
        >
          {badge.label}
        </span>
      )}
    </div>
  );
}

const METER_FILL: Record<"normal" | "warning" | "destructive", string> = {
  normal: "bg-primary",
  warning: "bg-warning",
  destructive: "bg-destructive",
};

const PENDING_HATCH =
  "text-primary bg-[repeating-linear-gradient(125deg,currentColor_0_1.5px,transparent_1.5px_5px)]";

export function UsageMeterRow({
  label,
  value,
  percent,
  pending,
  caption,
  tone = "normal",
  action,
}: {
  label: string;
  value: ReactNode;
  percent: number;
  pending?: { percent: number; label: string; usedLabel: string };
  caption?: string;
  tone?: "normal" | "warning" | "destructive";
  /** A button beside the meter, such as Add seats. */
  action?: ReactNode;
}): ReactElement {
  const clamped = Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : 0;
  const pendingPercent =
    pending && Number.isFinite(pending.percent)
      ? Math.min(clamped, Math.max(0, pending.percent))
      : 0;
  return (
    <div className="flex items-center gap-3 border-t border-border px-4 py-3.5 first:border-t-0">
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex min-w-0 items-baseline gap-2 text-sm">
          <span dir="auto" className="truncate text-foreground">
            {label}
          </span>
          <span dir="auto" className="truncate text-muted-foreground">
            {value}
          </span>
        </div>
        <div aria-hidden="true" className="flex h-3 overflow-hidden rounded-lg bg-surface-3">
          <div
            className={cn("h-full", METER_FILL[tone])}
            style={{ width: `${clamped - pendingPercent}%` }}
          />
          {pendingPercent > 0 && (
            <div className={cn("h-full", PENDING_HATCH)} style={{ width: `${pendingPercent}%` }} />
          )}
        </div>
        {(pending || caption) && (
          <div className="flex flex-wrap gap-x-2 gap-y-1 text-xs text-muted-foreground/70">
            {pending && (
              <span className="inline-flex items-center gap-1.5">
                <span className="sr-only">{pending.usedLabel}. </span>
                <span aria-hidden="true" className={cn("size-2.5 rounded-xs", PENDING_HATCH)} />
                <span dir="auto">{pending.label}</span>
              </span>
            )}
            {caption && <span dir="auto">{caption}</span>}
          </div>
        )}
      </div>
      {action}
    </div>
  );
}

export function UsageValueRow({ label, value }: { label: string; value: ReactNode }): ReactElement {
  return (
    <div className="flex flex-col gap-0.5 border-t border-border px-4 py-3.5 text-sm first:border-t-0">
      <span dir="auto" className="truncate text-foreground">
        {label}
      </span>
      {/* Inherits the row's direction: dir="auto" would put a bare number on the LTR side. */}
      <span className="truncate text-muted-foreground">{value}</span>
    </div>
  );
}

export function DetailRows({
  rows,
}: {
  rows: Array<{ label: string; value: ReactNode }>;
}): ReactElement {
  return (
    <div className="flex flex-col divide-y divide-border">
      {rows.map((row, index) => (
        <div key={`${index}-${row.label}`} className="flex items-start gap-3 px-2 py-3">
          <span dir="auto" className="w-[140px] shrink-0 text-xs text-muted-foreground/70">
            {row.label}
          </span>
          <span dir="auto" className="min-w-0 flex-1 truncate text-sm text-foreground">
            {row.value}
          </span>
        </div>
      ))}
    </div>
  );
}

export function BillingBanner({
  tone,
  title,
  body,
  action,
}: {
  tone: BillingTone;
  title: string;
  body?: string;
  action?: ReactNode;
}): ReactElement {
  return (
    <div
      role={tone === "destructive" ? "alert" : "status"}
      className={cn(
        "flex items-center justify-between gap-3 rounded-[10px] px-4 py-3",
        bannerToneClass(tone)
      )}
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <p dir="auto" className={cn("text-sm", titleToneClass(tone))}>
          {title}
        </p>
        {body && (
          <p dir="auto" className="text-xs text-muted-foreground">
            {body}
          </p>
        )}
      </div>
      {action}
    </div>
  );
}

export function PillButton({
  variant,
  icon: Icon,
  busy = false,
  className,
  children,
  disabled,
  type = "button",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant: "primary" | "secondary";
  icon?: IconComponent;
  busy?: boolean;
}): ReactElement {
  return (
    <button
      {...rest}
      type={type}
      data-variant={variant}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={cn(
        "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-full text-xs font-medium transition-opacity disabled:cursor-not-allowed disabled:opacity-60",
        variant === "primary"
          ? "bg-primary px-3.5 py-2 text-primary-foreground"
          : "bg-surface-3 px-4 py-2 text-muted-foreground",
        className
      )}
    >
      {busy ? (
        <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
      ) : (
        Icon && <Icon aria-hidden="true" className="size-3.5" />
      )}
      {children}
    </button>
  );
}
