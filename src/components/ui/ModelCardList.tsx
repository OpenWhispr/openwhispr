import { Globe, Download, Trash2, X, ExternalLink } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "./button";
import { cn } from "../lib/utils";
import type { ColorScheme } from "../../utils/modelPickerStyles";
import { createExternalLinkHandler, withUtm } from "../../utils/externalLinks";

export interface ModelCardOption {
  value: string;
  label: string;
  description?: string;
  specUrl?: string;
  icon?: string;
  invertInDark?: boolean;
  // Explicit group for SearchableModelList; falls back to the "provider/"
  // prefix of `value` when absent (e.g. Bedrock ids carry no slash).
  group?: string;
  // Local model properties (optional)
  isDownloaded?: boolean;
  isDownloading?: boolean;
  recommended?: boolean;
}

const COLOR_CONFIG: Record<
  ColorScheme,
  {
    selected: string;
    default: string;
  }
> = {
  purple: {
    selected:
      "border-primary/30 bg-primary/8 dark:bg-primary/6 dark:border-primary/20 shadow-[0_0_0_1px_oklch(0.62_0.22_260/0.12),0_0_10px_-3px_oklch(0.62_0.22_260/0.18)]",
    default:
      "border-border bg-surface-1 hover:border-border-hover hover:bg-muted dark:border-white/5 dark:bg-white/3 dark:hover:border-white/20 dark:hover:bg-white/8",
  },
  blue: {
    selected:
      "border-primary/30 bg-primary/10 dark:bg-primary/6 shadow-[0_0_0_1px_oklch(0.62_0.22_260/0.15),0_0_12px_-3px_oklch(0.62_0.22_260/0.2)]",
    default:
      "border-border bg-surface-1 hover:border-border-hover hover:bg-muted dark:border-white/5 dark:bg-white/3 dark:hover:border-white/20 dark:hover:bg-white/8",
  },
};

interface ModelCardProps {
  model: ModelCardOption;
  isSelected: boolean;
  onSelect: (modelId: string) => void;
  colorScheme?: ColorScheme;
  // Long-form descriptions (e.g. OpenRouter) fill the row and ellipsize
  // instead of sitting flush-right like short metadata.
  truncateDescription?: boolean;
  // Local model actions (optional - when provided, enables local model UI)
  onDownload?: (modelId: string) => void;
  onDelete?: (modelId: string) => void;
  onCancelDownload?: () => void;
  isCancelling?: boolean;
  isInstalling?: boolean;
}

export function ModelCard({
  model,
  isSelected,
  onSelect,
  colorScheme = "purple",
  truncateDescription = false,
  onDownload,
  onDelete,
  onCancelDownload,
  isCancelling = false,
  isInstalling = false,
}: ModelCardProps) {
  const { t } = useTranslation();
  const styles = COLOR_CONFIG[colorScheme];
  const isLocalMode = Boolean(onDownload);
  const isDownloaded = model.isDownloaded;
  const isDownloading = model.isDownloading;
  const specHref = model.specUrl ? withUtm(model.specUrl, "model_spec") : undefined;

  const handleCardClick = () => {
    if (isLocalMode) {
      if (isDownloaded && !isSelected) {
        onSelect(model.value);
      }
    } else {
      onSelect(model.value);
    }
  };

  const getStatusDotClass = () => {
    if (!isLocalMode) {
      return isSelected
        ? "bg-primary shadow-[0_0_6px_oklch(0.62_0.22_260/0.6)]"
        : "bg-muted-foreground/30";
    }
    if (isDownloaded) {
      return isSelected
        ? "bg-primary shadow-[0_0_6px_oklch(0.62_0.22_260/0.6)]"
        : "bg-success shadow-[0_0_4px_rgba(34,197,94,0.5)]";
    }
    if (isDownloading) {
      return "bg-amber-500 shadow-[0_0_4px_rgba(245,158,11,0.5)]";
    }
    return "bg-muted-foreground/20";
  };

  return (
    <div
      onClick={handleCardClick}
      className={`relative w-full p-2 rounded-md border text-left transition-colors duration-200 group overflow-hidden ${
        isSelected ? styles.selected : styles.default
      } ${!isLocalMode || (isDownloaded && !isSelected) ? "cursor-pointer" : ""}`}
    >
      <div className="flex items-center gap-1.5">
        <div
          className={`w-1.5 h-1.5 rounded-full shrink-0 ${getStatusDotClass()} ${
            isSelected && isDownloaded
              ? "animate-[pulse-glow_2s_ease-in-out_infinite]"
              : isDownloading
                ? "animate-[spinner-rotate_1s_linear_infinite]"
                : ""
          }`}
        />

        {model.icon ? (
          <img
            src={model.icon}
            alt=""
            className={`w-3.5 h-3.5 shrink-0 ${model.invertInDark ? "icon-monochrome" : ""}`}
            aria-hidden="true"
          />
        ) : (
          <Globe className="w-3.5 h-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        )}

        <span
          className={cn(
            "text-sm font-semibold text-foreground truncate tracking-tight",
            truncateDescription && (model.description ? "shrink-0 max-w-[60%]" : "min-w-0 flex-1")
          )}
        >
          {model.label}
        </span>
        {model.description && (
          <span
            className={
              truncateDescription
                ? "text-xs text-muted-foreground/60 truncate min-w-0 flex-1"
                : "text-xs text-muted-foreground/50 tabular-nums shrink-0"
            }
          >
            {model.description}
          </span>
        )}
        {specHref && (
          <a
            href={specHref}
            onClick={createExternalLinkHandler(specHref)}
            className="inline-flex items-center gap-0.5 text-xs text-primary/60 hover:text-primary transition-colors shrink-0"
          >
            {t("models.learnMore")}
            <ExternalLink size={9} />
          </a>
        )}

        {model.recommended && (
          <span className="text-xs font-medium text-primary px-1.5 py-0.5 bg-primary/10 rounded-sm shrink-0">
            {t("common.recommended")}
          </span>
        )}

        <div className="ml-auto flex items-center gap-1.5 shrink-0">
          {isSelected && (
            <span className="text-xs font-medium text-primary px-2 py-0.5 bg-primary/10 rounded-sm">
              {t("common.active")}
            </span>
          )}

          {isLocalMode && (
            <>
              {isDownloaded ? (
                <Button
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete?.(model.value);
                  }}
                  size="sm"
                  variant="ghost"
                  className="h-6 w-6 p-0 text-muted-foreground/40 hover:text-destructive opacity-0 group-hover:opacity-100 transition-[color,opacity,transform] active:scale-95"
                >
                  <Trash2 size={12} />
                </Button>
              ) : isDownloading ? (
                <Button
                  onClick={(e) => {
                    e.stopPropagation();
                    onCancelDownload?.();
                  }}
                  disabled={isCancelling || isInstalling}
                  size="sm"
                  variant="outline"
                  className="h-6 px-2.5 text-xs text-destructive border-destructive/25 hover:bg-destructive/8"
                >
                  <X size={11} className="mr-0.5" />
                  {isCancelling ? "..." : t("common.cancel")}
                </Button>
              ) : (
                <Button
                  onClick={(e) => {
                    e.stopPropagation();
                    onDownload?.(model.value);
                  }}
                  size="sm"
                  variant="default"
                  className="h-6 px-2.5 text-xs"
                >
                  <Download size={11} className="mr-1" />
                  {t("common.download")}
                </Button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

interface ModelCardListProps {
  models: ModelCardOption[];
  selectedModel: string;
  onModelSelect: (modelId: string) => void;
  colorScheme?: ColorScheme;
  className?: string;
  truncateDescription?: boolean;
  // Local model actions (optional - when provided, enables local model UI)
  onDownload?: (modelId: string) => void;
  onDelete?: (modelId: string) => void;
  onCancelDownload?: () => void;
  isCancelling?: boolean;
  isInstalling?: boolean;
}

export default function ModelCardList({
  models,
  selectedModel,
  onModelSelect,
  colorScheme = "purple",
  className = "",
  truncateDescription = false,
  onDownload,
  onDelete,
  onCancelDownload,
  isCancelling = false,
  isInstalling = false,
}: ModelCardListProps) {
  const { t } = useTranslation();

  if (models.length === 0) {
    return <p className="text-sm text-muted-foreground py-2">{t("models.noneAvailable")}</p>;
  }

  return (
    <div className={`space-y-0.5 ${className}`}>
      {models.map((model) => (
        <ModelCard
          key={model.value}
          model={model}
          isSelected={selectedModel === model.value}
          onSelect={onModelSelect}
          colorScheme={colorScheme}
          truncateDescription={truncateDescription}
          onDownload={onDownload}
          onDelete={onDelete}
          onCancelDownload={onCancelDownload}
          isCancelling={isCancelling}
          isInstalling={isInstalling}
        />
      ))}
    </div>
  );
}
