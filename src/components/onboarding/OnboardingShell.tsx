import type { ReactNode } from "react";
import { ChevronLeft } from "lucide-react";
import { Button } from "../ui/button";
import WindowControls from "../WindowControls";
import { getCachedPlatform } from "../../utils/platform";
import { useTranslation } from "react-i18next";

interface OnboardingShellProps {
  compact?: boolean;
  children: ReactNode;
  onBack?: () => void;
  onContinue?: () => void;
  onSkip?: () => void;
  continueLabel?: string;
  skipLabel?: string;
  continueDisabled?: boolean;
  continueLoading?: boolean;
  progressIndex?: number;
}

export function OnboardingProgress({ index }: { index: number }) {
  return (
    <div className="flex items-center justify-center gap-2" aria-hidden="true">
      {[0, 1, 2, 3].map((item) => (
        <span
          key={item}
          className={`h-1.5 rounded-full transition-[width,background-color] ${
            item === index ? "w-8 bg-foreground" : item < index ? "w-5 bg-primary" : "w-5 bg-border"
          }`}
        />
      ))}
    </div>
  );
}

export function OnboardingStepHeader({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  return (
    <header className="mx-auto max-w-2xl space-y-3 text-center">
      <h1 className="text-3xl font-medium tracking-tight text-foreground md:text-4xl">{title}</h1>
      {description && (
        <p className="text-sm leading-6 text-muted-foreground md:text-base">{description}</p>
      )}
    </header>
  );
}

export default function OnboardingShell({
  compact = false,
  children,
  onBack,
  onContinue,
  onSkip,
  continueLabel,
  skipLabel,
  continueDisabled = false,
  continueLoading = false,
  progressIndex,
}: OnboardingShellProps) {
  const { t } = useTranslation();
  const platform = getCachedPlatform();
  const hasFooter = onBack || onContinue || onSkip || progressIndex !== undefined;

  return (
    <main
      className={`onboarding-canvas flex h-screen flex-col overflow-hidden ${compact ? "compact" : ""}`}
    >
      <div
        className="flex h-10 shrink-0 items-center justify-end"
        style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
      >
        {platform !== "darwin" && (
          <div className="pr-1" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
            <WindowControls />
          </div>
        )}
      </div>

      <div
        className={`min-h-0 flex-1 overflow-y-auto ${compact ? "px-0 pb-0" : "px-6 py-8 md:px-12"}`}
      >
        <div
          className={`mx-auto flex min-h-full w-full items-center justify-center ${compact ? "max-w-none" : "max-w-6xl"}`}
        >
          {children}
        </div>
      </div>

      {hasFooter && (
        <footer className="shrink-0 px-6 pb-5 pt-3 md:px-12">
          <div className="mx-auto grid w-full max-w-6xl grid-cols-[1fr_auto_1fr] items-center gap-4">
            <div>
              {onBack && (
                <Button type="button" variant="ghost" onClick={onBack} className="rounded-full">
                  <ChevronLeft className="size-4" />
                  {t("common.back")}
                </Button>
              )}
            </div>

            {progressIndex !== undefined ? <OnboardingProgress index={progressIndex} /> : <div />}

            <div className="flex justify-end gap-2">
              {onSkip && (
                <Button type="button" variant="ghost" onClick={onSkip} className="rounded-full">
                  {skipLabel ?? t("common.skip")}
                </Button>
              )}
              {onContinue && (
                <Button
                  type="button"
                  onClick={onContinue}
                  disabled={continueDisabled || continueLoading}
                  className="min-w-28 rounded-full"
                >
                  {continueLoading ? t("common.loading") : (continueLabel ?? t("common.continue"))}
                </Button>
              )}
            </div>
          </div>
        </footer>
      )}
    </main>
  );
}

export function BrandMark({ className = "" }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 1024 1024"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <circle cx="512" cy="512" r="314" stroke="currentColor" strokeWidth="74" />
      <path d="M512 383V641" stroke="currentColor" strokeWidth="74" strokeLinecap="round" />
      <path d="M627 457V568" stroke="currentColor" strokeWidth="74" strokeLinecap="round" />
      <path d="M397 457V568" stroke="currentColor" strokeWidth="74" strokeLinecap="round" />
    </svg>
  );
}
