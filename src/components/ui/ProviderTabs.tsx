import { ReactNode, useRef, useEffect, useLayoutEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { ProviderIcon } from "./ProviderIcon";
import type { ColorScheme as BaseColorScheme } from "../../utils/modelPickerStyles";

export interface ProviderTabItem {
  id: string;
  name: string;
  recommended?: boolean;
}

type ColorScheme = Exclude<BaseColorScheme, "blue"> | "dynamic";

interface ProviderTabsProps {
  providers: ProviderTabItem[];
  selectedId: string;
  onSelect: (id: string) => void;
  renderIcon?: (providerId: string) => ReactNode;
  colorScheme?: ColorScheme;
  /** Allow horizontal scrolling for many providers */
  scrollable?: boolean;
}

export function ProviderTabs({
  providers,
  selectedId,
  onSelect,
  renderIcon,
  colorScheme = "purple",
  scrollable = false,
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

    const containerRect = container.getBoundingClientRect();
    const buttonRect = selectedButton.getBoundingClientRect();

    indicator.style.width = `${buttonRect.width}px`;
    indicator.style.height = `${buttonRect.height}px`;
    indicator.style.transform = `translateX(${buttonRect.left - containerRect.left}px)`;
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
      className={`relative inline-flex items-center gap-0.5 p-0.5 ${scrollable ? "overflow-x-auto" : ""}`}
    >
      <div
        ref={indicatorRef}
        className="absolute top-0.5 left-0 rounded-full bg-primary/10 dark:bg-primary/15 ring-1 ring-primary/30 dark:ring-primary/25 transition-[width,height,transform,opacity] duration-200 ease-out pointer-events-none"
        style={{ opacity: 0 }}
      />

      {providers.map((provider) => {
        const isSelected = selectedId === provider.id;

        return (
          <button
            key={provider.id}
            data-tab-button
            onClick={() => onSelect(provider.id)}
            className={`relative z-10 flex items-center gap-1 px-2.5 py-1 rounded-full font-medium text-xs transition-colors duration-150 ${
              scrollable ? "whitespace-nowrap" : ""
            } ${isSelected ? "text-foreground [&_svg]:text-primary" : "text-muted-foreground ring-1 ring-border/60 dark:ring-white/10 hover:text-foreground hover:bg-foreground/4 dark:hover:bg-white/5"}`}
          >
            {renderIcon ? renderIcon(provider.id) : <ProviderIcon provider={provider.id} />}
            <span>{provider.name}</span>
            {provider.recommended && (
              <span className="text-[10px] text-primary/70 font-medium">
                {t("common.recommended")}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
