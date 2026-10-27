// "We recommend these settings": the local setup card. It shows what the app
// read about this computer, the three picks (dictation, cleanup, assistant) with
// how fast each will feel, and one button that downloads them in turn. The page
// title and subtitle belong to OnboardingFlow, which names the computer and the
// languages with the same helpers (localSetupLabels.ts). Settings are only
// written by onProceed.
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import { ProviderIcon } from "../ui/ProviderIcon";
import { Check, Globe, Laptop, Monitor } from "../icons";
import { AnimatedEllipsis } from "./AnimatedEllipsis";
import {
  formatLocalSetupSeconds,
  localSetupComputerName,
  localSetupLanguageLabel,
} from "./localSetupLabels";
import {
  enabledDownloads,
  fitLocalSetupToSpace,
  isAppleChipMac,
  rowSizeLabel,
  type LocalSetupDownload,
  type LocalSetupLine,
  type LocalSetupPlan,
  type LocalSetupRow,
  type LocalSetupRowId,
  type LocalSetupSwitches,
} from "../../config/localSetup";
import type { ComputerProfile } from "../../types/electron";
import { isQueued, localSetupItemKey } from "./localSetupDownloadState";
import { useLocalSetupDownloads, type LocalSetupRowProgress } from "./useLocalSetupDownloads";
import { useLocalSetupSpace } from "./useLocalSetupSpace";

type Translate = (key: string, options?: Record<string, unknown>) => string;
type Fit = ReturnType<typeof fitLocalSetupToSpace>;

const DASH = "–";

const CARD_CLASS =
  "mt-8 mx-auto w-full max-w-[30rem] rounded-[1.125rem] border border-[var(--onboarding-control-border)] bg-[var(--onboarding-surface)] px-4 py-4 text-[var(--onboarding-text-primary)]";
const PANEL_CLASS =
  "rounded-2xl border border-[var(--onboarding-control-border)] bg-[var(--onboarding-surface-secondary)]";
const TILE_CLASS =
  "relative flex size-11 shrink-0 items-center justify-center rounded-xl border border-[var(--onboarding-control-border)] bg-[var(--onboarding-surface)]";
// The app's one grey badge (SetupChoiceStep's "Free").
const BADGE_CLASS =
  "rounded-[47px] bg-[var(--onboarding-surface-tertiary)] px-[9px] py-1 text-[10px] leading-[1.4] text-[var(--onboarding-text-primary)]";
// The button while it can't be pressed: flat grey instead of the brand glass.
const BUTTON_GREY_CLASS =
  "bg-none bg-[var(--onboarding-surface-secondary)] text-[var(--onboarding-text-tertiary)] shadow-none border border-[var(--onboarding-control-border)] disabled:opacity-100";

const ROW_KIND_KEYS: Record<LocalSetupRowId, string> = {
  dictation: "onboarding.rehaul.localSetup.rows.dictation",
  cleanup: "onboarding.rehaul.localSetup.rows.cleanup",
  assistant: "onboarding.rehaul.localSetup.rows.assistant",
};
const BADGE_KEYS: Record<NonNullable<LocalSetupRow["label"]>, string> = {
  fast: "onboarding.rehaul.localSetup.badge.fast",
  slower: "onboarding.rehaul.localSetup.badge.slower",
  unavailable: "onboarding.rehaul.localSetup.badge.cloud",
};

const formatGb = (bytes: number) => (bytes / 1e9).toFixed(1);

function lineText(line: LocalSetupLine, onMac: boolean, t: Translate): string | null {
  switch (line.key) {
    case "dictationSeconds":
      return t("onboarding.rehaul.localSetup.line.dictationSeconds", {
        seconds: formatLocalSetupSeconds(line.range),
      });
    case "dictationFewSeconds":
      return t("onboarding.rehaul.localSetup.line.dictationFewSeconds");
    case "cleanupUnderSecond":
      return t("onboarding.rehaul.localSetup.line.cleanupUnderSecond");
    case "cleanupAddsSeconds":
      return t("onboarding.rehaul.localSetup.line.cleanupAddsSeconds", {
        seconds: formatLocalSetupSeconds(line.range),
      });
    case "assistantSeconds":
      return t("onboarding.rehaul.localSetup.line.assistantSeconds", {
        seconds: formatLocalSetupSeconds(line.range),
      });
    case "requiredByOrganization":
      return t("onboarding.rehaul.localSetup.line.requiredByOrganization");
    case "tooSlowMinutes":
      return t("onboarding.rehaul.localSetup.unavailable.tooSlowMinutes", {
        model: line.model,
        minutes: line.minutes,
      });
    case "tooSlowAboutMinute":
      return t("onboarding.rehaul.localSetup.unavailable.tooSlowAboutMinute", {
        model: line.model,
      });
    case "tooSlowCleanupSeconds":
      return t("onboarding.rehaul.localSetup.unavailable.tooSlowCleanupSeconds", {
        model: line.model,
        seconds: Math.round(line.seconds),
      });
    case "tooSlowAssistantSeconds":
      return t("onboarding.rehaul.localSetup.unavailable.tooSlowAssistantSeconds", {
        model: line.model,
        seconds: formatLocalSetupSeconds(line.range),
      });
    case "notEnoughMemory": {
      // Memory that couldn't be read would print "has 0 GB": the heading says enough.
      if (!(line.haveGb > 0)) return null;
      const values = { model: line.model, needed: line.neededGb, have: line.haveGb };
      return onMac
        ? t("onboarding.rehaul.localSetup.unavailable.memoryMac", values)
        : t("onboarding.rehaul.localSetup.unavailable.memoryComputer", values);
    }
  }
}

function ComputerCard({ profile, languages }: { profile: ComputerProfile; languages: string[] }) {
  const { t, i18n } = useTranslation();
  const appleChip = isAppleChipMac(profile);
  const DeviceIcon = profile.formFactor === "laptop" ? Laptop : Monitor;
  const cells: Array<[string, string]> = [
    [
      appleChip
        ? t("onboarding.rehaul.localSetup.computer.chip")
        : t("onboarding.rehaul.localSetup.computer.processor"),
      profile.processorName || DASH,
    ],
    [
      t("onboarding.rehaul.localSetup.computer.memory"),
      profile.memoryGb > 0
        ? t("onboarding.rehaul.localSetup.computer.memoryValue", { gb: profile.memoryGb })
        : DASH,
    ],
    [
      t("onboarding.rehaul.localSetup.computer.graphics"),
      appleChip
        ? t("onboarding.rehaul.localSetup.computer.builtIn")
        : (profile.graphicsName ?? profile.nvidia?.name ?? DASH),
    ],
  ];

  return (
    <div className={`${PANEL_CLASS} px-2 pb-2 pt-3`}>
      <div className="flex items-center gap-3">
        <span className={TILE_CLASS}>
          <DeviceIcon className="size-5" />
        </span>
        <span className="min-w-0 flex-1 truncate text-base font-medium text-[var(--onboarding-text-primary)]">
          {localSetupComputerName(profile, t)}
        </span>
        <span className="flex h-7 min-w-0 max-w-[50%] shrink-0 items-center gap-1.5 rounded-full border border-[var(--onboarding-control-border)] px-2.5 text-sm text-[var(--onboarding-text-secondary)]">
          <Globe className="size-4 shrink-0" />
          <span className="truncate">{localSetupLanguageLabel(languages, i18n.language)}</span>
        </span>
      </div>
      <div className="mt-3 grid grid-cols-3 border-t border-[var(--onboarding-control-border)]">
        {cells.map(([label, value], index) => (
          <div
            key={label}
            className={`min-w-0 px-2 pb-1 pt-2.5 ${
              index > 0 ? "border-s border-[var(--onboarding-control-border)] ps-3" : ""
            }`}
          >
            <span className="block text-xs text-[var(--onboarding-text-tertiary)]">{label}</span>
            <span className="mt-0.5 block text-sm font-medium leading-[1.3] text-[var(--onboarding-text-primary)]">
              {value}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Download progress drawn over the row's icon; no wedge while the row waits its turn. */
function DownloadPie({ percent, label }: { percent: number | null; label: string }) {
  const center = 13;
  const radius = 7.5;
  let wedge = null;
  if (percent != null && percent >= 99.9) {
    wedge = <circle cx={center} cy={center} r={radius} fill="var(--onboarding-accent)" />;
  } else if (percent != null && percent > 0) {
    const angle = (2 * Math.PI * percent) / 100;
    const x = (center + radius * Math.sin(angle)).toFixed(2);
    const y = (center - radius * Math.cos(angle)).toFixed(2);
    const large = percent > 50 ? 1 : 0;
    wedge = (
      <path
        d={`M${center} ${center} L${center} ${center - radius} A${radius} ${radius} 0 ${large} 1 ${x} ${y} Z`}
        fill="var(--onboarding-accent)"
      />
    );
  }
  return (
    <svg
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent ?? undefined}
      className="absolute inset-0 m-auto"
      width="26"
      height="26"
      viewBox="0 0 26 26"
    >
      <circle
        cx={center}
        cy={center}
        r="10"
        fill="rgba(0,0,0,.45)"
        stroke="var(--onboarding-accent)"
        strokeWidth="1.6"
      />
      {wedge}
    </svg>
  );
}

function SetupSwitch({
  checked,
  disabled,
  label,
  onToggle,
}: {
  checked: boolean;
  disabled: boolean;
  label: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={onToggle}
      className={`relative h-[1.375rem] w-9 shrink-0 cursor-pointer rounded-full transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--onboarding-accent)_30%,transparent)] disabled:cursor-default disabled:opacity-60 ${
        checked ? "bg-[var(--onboarding-accent)]" : "bg-[var(--onboarding-surface-tertiary)]"
      }`}
    >
      <span
        className={`absolute top-[3px] size-4 rounded-full bg-white transition-[inset-inline-start] duration-200 ${
          checked ? "start-[calc(100%-1rem-3px)]" : "start-[3px]"
        }`}
      />
    </button>
  );
}

function SetupRow({
  row,
  on,
  description,
  size,
  progress,
  started,
  switchable,
  onToggle,
  onRetry,
}: {
  row: LocalSetupRow;
  on: boolean;
  description: string | null;
  size: string;
  progress: LocalSetupRowProgress;
  started: boolean;
  switchable: boolean;
  onToggle: () => void;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  const unavailable = row.label === "unavailable";
  const active = on && !unavailable;
  const kind = t(ROW_KIND_KEYS[row.id]);
  const showPie = started && active && isQueued(progress.status);
  const done = active && progress.status === "done";
  const failed = active && progress.status === "failed";
  const dim = !unavailable && !on;

  const badge = failed ? (
    <button
      type="button"
      onClick={onRetry}
      aria-label={t("onboarding.rehaul.localSetup.retryRow", { row: kind })}
      className="ms-1.5 shrink-0 cursor-pointer rounded-full px-1.5 text-xs font-medium text-[var(--onboarding-accent)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--onboarding-accent)_30%,transparent)]"
    >
      {t("onboarding.rehaul.localSetup.retry")}
    </button>
  ) : row.label ? (
    <span className={`ms-1.5 shrink-0 ${BADGE_CLASS}`}>{t(BADGE_KEYS[row.label])}</span>
  ) : null;

  return (
    <div
      data-local-setup-row={row.id}
      className="flex h-24 items-center gap-3 border-b border-[var(--onboarding-control-border)] px-2 last:border-b-0"
    >
      <span className={`${TILE_CLASS} ${dim ? "opacity-55" : ""}`}>
        {unavailable ? (
          <span className="text-[1.1rem] text-[var(--onboarding-text-tertiary)]">{DASH}</span>
        ) : (
          <ProviderIcon
            provider={row.providerIcon}
            className={`size-5 ${showPie ? "opacity-30" : ""}`}
          />
        )}
        {showPie && (
          <DownloadPie
            percent={progress.status === "waiting" ? null : progress.percent}
            label={kind}
          />
        )}
        {done && (
          <span
            role="img"
            aria-label={t("onboarding.rehaul.localSetup.downloaded")}
            className="absolute -bottom-[5px] -end-[5px] flex size-[18px] items-center justify-center rounded-full border-2 border-[var(--onboarding-surface-secondary)] bg-[var(--onboarding-success)] text-[var(--onboarding-success-foreground)]"
          >
            <Check className="size-3" aria-hidden="true" />
          </span>
        )}
      </span>

      <div className={`min-w-0 flex-1 ${dim ? "opacity-55" : ""}`}>
        <span className="block text-xs leading-4 text-[var(--onboarding-text-tertiary)]">
          {kind}
        </span>
        <span className="mt-0.5 flex min-w-0 items-center whitespace-nowrap text-base font-medium leading-6 text-[var(--onboarding-text-primary)]">
          {/* Only the name gives way to a long translation; size and badge stay whole. */}
          <span className="min-w-0 truncate">
            {unavailable
              ? row.reason === "memory"
                ? t("onboarding.rehaul.localSetup.unavailable.notEnoughMemory")
                : t("onboarding.rehaul.localSetup.unavailable.tooSlow")
              : row.modelName}
          </span>
          {!unavailable && (
            <span className="ms-1 shrink-0 text-sm font-normal tabular-nums text-[var(--onboarding-text-secondary)]">
              · {size}
            </span>
          )}
          {badge}
        </span>
        {/* Two lines, so a reason like "…would take over 3 minutes to start answering"
            reads in full; the row height is fixed for two. The title catches a
            translation longer than that. */}
        <span
          className="mt-0.5 line-clamp-2 text-sm leading-5 text-[var(--onboarding-text-secondary)]"
          title={description ?? undefined}
        >
          {description}
        </span>
      </div>

      {/* Fixed width, so a row reads the same with or without its switch. Dictation
          can't be switched off and has none, which leaves its name more room. */}
      {switchable && (
        <span className="flex w-12 shrink-0 justify-end">
          {!unavailable && (
            <SetupSwitch checked={on} disabled={started} label={kind} onToggle={onToggle} />
          )}
        </span>
      )}
    </div>
  );
}

export function LocalSetupStep({
  plan,
  onProceed,
}: {
  plan: LocalSetupPlan;
  onProceed: (switches: LocalSetupSwitches) => void;
}) {
  const { t } = useTranslation();
  const space = useLocalSetupSpace();
  // Switches the user set. Empty until the first flip, so the space fit may turn
  // rows off; after a flip it holds both, so the fit never overrides the user.
  const [requested, setRequested] = useState<Partial<LocalSetupSwitches>>({});
  // Rows the fit had turned off when the user took over, for their "off to fit" line.
  const [keptOffToFit, setKeptOffToFit] = useState<LocalSetupRowId[]>([]);
  // The fit at the moment Download was pressed: later space reads don't move it.
  const [frozenFit, setFrozenFit] = useState<Fit | null>(null);
  // What the inventory found on disk. It arrives through the downloads hook, which
  // itself needs the fitted switches, so it is copied here (see below the hook).
  const [onDisk, setOnDisk] = useState<string[]>([]);
  const [inventoryLoaded, setInventoryLoaded] = useState(false);

  const liveFit = useMemo<Fit>(() => {
    // Models already downloaded (say, before Back) need no free space, so the fit
    // waits for the inventory too: a returning user never sees a row trimmed for a
    // frame because what is on disk wasn't known yet.
    const isOnDisk = (item: LocalSetupDownload) => onDisk.includes(localSetupItemKey(item));
    if (space && inventoryLoaded) return fitLocalSetupToSpace(plan, requested, space, isOnDisk);
    // Not read yet: everything fits until the reads say otherwise.
    return {
      switches: { cleanup: requested.cleanup ?? true, assistant: requested.assistant ?? true },
      autoOff: [],
      state: "fits",
      requiredBytes: 0,
    };
  }, [plan, requested, space, onDisk, inventoryLoaded]);
  const fit = frozenFit ?? liveFit;
  const { switches } = fit;

  const downloads = useLocalSetupDownloads(plan, switches);
  // Adjusting state during render: React re-renders straight away with the new
  // inventory, before anything is committed, so the fit never shows stale rows.
  if (downloads.onDisk !== onDisk) setOnDisk(downloads.onDisk);
  if (downloads.inventoryLoaded !== inventoryLoaded) setInventoryLoaded(downloads.inventoryLoaded);
  const queue = useMemo(() => enabledDownloads(plan, switches), [plan, switches]);
  const onMac = plan.profile.platform === "darwin";

  const offToFit = [...fit.autoOff, ...keptOffToFit].filter(
    (id) => id !== "dictation" && !switches[id]
  );
  const busy = queue.some(({ rowId }) => isQueued(downloads.rows[rowId].status));
  const phase: "proceed" | "download" | "downloading" | "failed" | "noSpace" = downloads.allDone
    ? "proceed"
    : downloads.started
      ? busy
        ? "downloading"
        : "failed"
      : fit.state === "noSpace" || fit.state === "overflow"
        ? "noSpace"
        : "download";

  const toggle = (id: keyof LocalSetupSwitches) => {
    if (downloads.started) return;
    setKeptOffToFit((kept) => [...new Set([...kept, ...liveFit.autoOff])].filter((r) => r !== id));
    setRequested({ ...liveFit.switches, [id]: !liveFit.switches[id] });
  };

  const press = () => {
    if (phase === "proceed") {
      onProceed(switches);
    } else if (phase === "download") {
      setFrozenFit(liveFit);
      downloads.start();
    }
  };

  let foot = t("onboarding.rehaul.localSetup.foot.default");
  if (space && !downloads.started && !downloads.allDone) {
    const values = { needed: formatGb(fit.requiredBytes), free: formatGb(space.availableBytes) };
    if (fit.state === "noSpace") {
      foot = onMac
        ? t("onboarding.rehaul.localSetup.foot.noSpaceMac", values)
        : t("onboarding.rehaul.localSetup.foot.noSpaceComputer", values);
    } else if (fit.state === "overflow" || offToFit.length > 0) {
      foot = onMac
        ? t("onboarding.rehaul.localSetup.foot.needsMac", values)
        : t("onboarding.rehaul.localSetup.foot.needsComputer", values);
    }
  }

  const describe = (row: LocalSetupRow, on: boolean): string | null => {
    if (row.label !== "unavailable" && !on) {
      return offToFit.includes(row.id)
        ? t("onboarding.rehaul.localSetup.line.offToFit")
        : t("onboarding.rehaul.localSetup.line.off");
    }
    return lineText(row.line, onMac, t);
  };

  return (
    <section className={CARD_CLASS}>
      <ComputerCard profile={plan.profile} languages={plan.languages} />

      <div className={`mt-4 ${PANEL_CLASS}`}>
        {plan.rows.map((row) => {
          const on = row.id === "dictation" || switches[row.id];
          // The graphics pack's size shows on the row it downloads with, unnamed.
          const pack =
            queue
              .find(({ rowId }) => rowId === row.id)
              ?.items.find((item) => item.kind === "llamaVulkan") ?? null;
          return (
            <SetupRow
              key={row.id}
              row={row}
              on={on}
              description={describe(row, on)}
              size={rowSizeLabel(row, pack)}
              progress={downloads.rows[row.id]}
              started={downloads.started}
              switchable={row.id !== "dictation"}
              onToggle={() => row.id !== "dictation" && toggle(row.id)}
              onRetry={() => downloads.retry(row.id)}
            />
          );
        })}
      </div>

      <div className="mt-5">
        <Button
          type="button"
          onClick={press}
          disabled={phase !== "proceed" && phase !== "download"}
          className={`h-10 w-full rounded-[38px] px-5 text-sm ${
            phase === "proceed" || phase === "download" ? "" : BUTTON_GREY_CLASS
          }`}
        >
          {phase === "proceed" || phase === "failed" ? (
            t("onboarding.rehaul.localSetup.button.proceed")
          ) : phase === "downloading" ? (
            <span>
              {t("onboarding.rehaul.localSetup.button.downloading")}
              <span className="inline-block w-[1.1em] text-start">
                <AnimatedEllipsis />
              </span>
            </span>
          ) : phase === "noSpace" ? (
            t("onboarding.rehaul.localSetup.button.noSpace")
          ) : (
            t("onboarding.rehaul.localSetup.button.download")
          )}
        </Button>
      </div>
      <p
        data-local-setup-foot=""
        className="mx-1 mt-3 text-center text-xs leading-normal text-[var(--onboarding-text-tertiary)]"
      >
        {foot}
      </p>
    </section>
  );
}

/**
 * The card's frame, at about the height of three rows, while the plan is still
 * being worked out (the computer or policy read hasn't landed). Rare: both
 * finish long before anyone reaches the step.
 */
export function LocalSetupStepPlaceholder() {
  return <section aria-busy="true" className={`${CARD_CLASS} h-[35rem]`} />;
}
