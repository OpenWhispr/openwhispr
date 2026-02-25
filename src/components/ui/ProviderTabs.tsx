import { ReactNode, useRef, useState, useEffect, useCallback } from "react";
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
  const [indicatorStyle, setIndicatorStyle] = useState<React.CSSProperties>({
    opacity: 0,
  });

  const updateIndicator = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    const selectedIndex = providers.findIndex((p) => p.id === selectedId);
    if (selectedIndex === -1) {
      setIndicatorStyle({ opacity: 0 });
      return;
    }

    const buttons = container.querySelectorAll<HTMLButtonElement>("[data-tab-button]");
    const selectedButton = buttons[selectedIndex];
    if (!selectedButton) return;

    const containerRect = container.getBoundingClientRect();
    const buttonRect = selectedButton.getBoundingClientRect();

    setIndicatorStyle({
      width: buttonRect.width,
      height: buttonRect.height,
      transform: `translateX(${buttonRect.left - containerRect.left}px)`,
      opacity: 1,
    });
  }, [providers, selectedId]);

  useEffect(() => {
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
      className={`relative flex p-0.5 rounded-md bg-surface-raised dark:bg-surface-1 ${scrollable ? "overflow-x-auto" : ""}`}
    >
      {/* Sliding indicator - frosted glass treatment */}
      <div
        className="absolute top-0.5 left-0 rounded-md bg-card border border-border dark:border-border-subtle shadow-sm dark:shadow-(--shadow-card) transition-[width,height,transform,opacity] duration-200 ease-out pointer-events-none"
        style={indicatorStyle}
      />

      {providers.map((provider) => {
        const isSelected = selectedId === provider.id;

        return (
          <button
            key={provider.id}
            data-tab-button
            onClick={() => onSelect(provider.id)}
            className={`relative z-10 flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md font-medium text-xs transition-colors duration-150 ${
              scrollable ? "whitespace-nowrap" : ""
            } ${isSelected ? "text-foreground" : "text-muted-foreground hover:text-foreground"}`}
          >
            {renderIcon ? renderIcon(provider.id) : <ProviderIcon provider={provider.id} />}
            <span>{provider.name}</span>
            {provider.recommended && (
              <span className="text-xs text-primary/70 font-medium">{t("common.recommended")}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
