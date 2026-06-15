import { ReactNode, useRef, useEffect, useLayoutEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { ProviderIcon } from "./ProviderIcon";
import type { ColorScheme as BaseColorScheme } from "../../utils/modelPickerStyles";
import { cn } from "../lib/utils";

export interface ProviderTabItem {
  id: string;
  name: string;
  recommended?: boolean;
  disabled?: boolean;
  disabledLabel?: string;
}

type ColorScheme = Exclude<BaseColorScheme, "blue"> | "dynamic";

interface ProviderTabsProps {
  providers: ProviderTabItem[];
  selectedId: string;
  onSelect: (id: string) => void;
  renderIcon?: (providerId: string) => ReactNode;
  colorScheme?: ColorScheme;
  /** Wrap pills onto multiple lines when there are many providers */
  wrap?: boolean;
}

export function ProviderTabs({
  providers,
  selectedId,
  onSelect,
  renderIcon,
  colorScheme = "purple",
  wrap = false,
}: ProviderTabsProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const indicatorRef = useRef<HTMLDivElement>(null);

  const updateIndicator = useCallback(() => {
    const container = containerRef.current;
    const indicator = indicatorRef.current;
    if (!container || !indicator) return;

    const selectedIndex = providers.findIndex((p) => p.id === selectedId);
    if (selectedIndex === -1) {
      indicator.style.opacity = "0";
      return;
    }

    const buttons = container.querySelectorAll<HTMLButtonElement>("[data-tab-button]");
    const selectedButton = buttons[selectedIndex];
    if (!selectedButton) return;

    const buttonRect = selectedButton.getBoundingClientRect();

    indicator.style.width = `${buttonRect.width}px`;
    indicator.style.height = `${buttonRect.height}px`;
    indicator.style.transform = `translate(${selectedButton.offsetLeft}px, ${selectedButton.offsetTop}px)`;
    indicator.style.opacity = "1";
  }, [providers, selectedId]);

  useLayoutEffect(() => {
    updateIndicator();
  }, [updateIndicator]);

  useEffect(() => {
    const observer = new ResizeObserver(() => updateIndicator());
    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [updateIndicator]);

  return (
    <div
      ref={containerRef}
      className={cn("relative items-center gap-1 p-0.5", wrap ? "flex flex-wrap" : "inline-flex")}
    >
      <div
        ref={indicatorRef}
        className="absolute top-0 left-0 rounded-full bg-primary/10 dark:bg-primary/15 ring-1 ring-primary/30 dark:ring-primary/25 transition-[width,height,transform,opacity] duration-200 ease-out pointer-events-none"
        style={{ opacity: 0 }}
      />

      {providers.map((provider) => {
        const isSelected = selectedId === provider.id;
        const isDisabled = !!provider.disabled;

        return (
          <button
            key={provider.id}
            data-tab-button
            type="button"
            disabled={isDisabled}
            aria-disabled={isDisabled}
            title={isDisabled ? provider.disabledLabel : undefined}
            onClick={() => {
              if (isDisabled) return;
              onSelect(provider.id);
            }}
            className={cn(
              "relative z-10 flex items-center gap-1 px-2.5 py-1 rounded-full font-medium text-xs whitespace-nowrap transition-colors duration-150",
              isDisabled
                ? "text-muted-foreground/50 cursor-not-allowed ring-1 ring-border/40 dark:ring-white/5"
                : isSelected
                  ? "text-foreground [&_svg]:text-primary"
                  : "text-muted-foreground ring-1 ring-border/60 dark:ring-white/10 hover:text-foreground hover:bg-foreground/4 dark:hover:bg-white/5"
            )}
          >
            {renderIcon ? renderIcon(provider.id) : <ProviderIcon provider={provider.id} />}
            <span>{provider.name}</span>
            {provider.recommended && (
              <span className="text-[10px] text-primary/70 font-medium">
                {t("common.recommended")}
              </span>
            )}
            {isDisabled && provider.disabledLabel && (
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground/70">
                {provider.disabledLabel}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
