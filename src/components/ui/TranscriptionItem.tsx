import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./button";
import { Copy, Trash2 } from "lucide-react";
import type { TranscriptionItem as TranscriptionItemType } from "../../types/electron";
import { cn } from "../lib/utils";

interface TranscriptionItemProps {
  item: TranscriptionItemType;
  onCopy: (text: string) => void;
  onDelete: (id: number) => void;
}

export default function TranscriptionItem({ item, onCopy, onDelete }: TranscriptionItemProps) {
  const { i18n } = useTranslation();
  const [isHovered, setIsHovered] = useState(false);

  const timestampSource = item.timestamp.endsWith("Z") ? item.timestamp : `${item.timestamp}Z`;
  const timestampDate = new Date(timestampSource);
  const formattedTime = Number.isNaN(timestampDate.getTime())
    ? ""
    : timestampDate.toLocaleTimeString(i18n.language, {
        hour: "2-digit",
        minute: "2-digit",
      });

  return (
    <div
      className="group rounded-md border border-border/40 dark:border-border-subtle/60 bg-card/50 dark:bg-surface-2/60 px-3 py-2.5 transition-colors duration-150 hover:bg-muted/30 dark:hover:bg-surface-2/80"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <div className="flex items-start gap-3">
        {formattedTime && (
          <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums pt-0.5">
            {formattedTime}
          </span>
        )}

        <p className="flex-1 min-w-0 text-foreground text-sm leading-[1.5] break-words">
          {item.text}
        </p>

        <div
          className={cn(
            "flex items-center gap-0.5 shrink-0 transition-opacity duration-150",
            isHovered ? "opacity-100" : "opacity-0"
          )}
        >
          <Button
            size="icon"
            variant="ghost"
            onClick={() => onCopy(item.text)}
            className="h-6 w-6 rounded-sm text-muted-foreground hover:text-foreground hover:bg-foreground/10"
          >
            <Copy size={12} />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            onClick={() => onDelete(item.id)}
            className="h-6 w-6 rounded-sm text-muted-foreground hover:text-destructive hover:bg-destructive/10"
          >
            <Trash2 size={12} />
          </Button>
        </div>
      </div>
    </div>
  );
}
