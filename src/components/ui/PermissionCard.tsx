import { Button } from "./button";
import { Check, LucideIcon, Settings } from "lucide-react";
import { cn } from "../lib/utils";

interface PermissionCardProps {
  icon: LucideIcon;
  title: string;
  description: string;
  granted: boolean;
  onRequest: () => void;
  buttonText?: string;
  onOpenSettings?: () => void;
}

export default function PermissionCard({
  icon: Icon,
  title,
  description,
  granted,
  onRequest,
  buttonText = "Grant Access",
  onOpenSettings,
}: PermissionCardProps) {
  return (
    <div
      className={cn(
        "group relative rounded-md p-3 transition-colors duration-150",
        "border",
        granted
          ? "bg-success/5 border-success/20 dark:bg-success/5 dark:border-success/15"
          : "bg-surface-1 border-border hover:bg-surface-2 hover:border-border-hover"
      )}
    >
      <div className="flex items-center gap-3">
        {/* Icon container */}
        <div
          className={cn(
            "w-8 h-8 rounded-md flex items-center justify-center shrink-0 transition-colors duration-150",
            granted
              ? "bg-success/10 dark:bg-success/15"
              : "bg-primary/10 dark:bg-primary/15 group-hover:bg-primary/15"
          )}
        >
          {granted ? (
            <Check className="w-4 h-4 text-success" strokeWidth={2.5} />
          ) : (
            <Icon className="w-4 h-4 text-primary" />
          )}
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <h3 className="text-xs font-medium text-foreground">{title}</h3>
          <p className="text-xs text-muted-foreground leading-snug mt-0.5">{description}</p>
        </div>

        {/* Actions - only when not granted */}
        {!granted && (
          <div className="flex items-center gap-1.5 shrink-0">
            <Button onClick={onRequest} size="sm" className="h-7 px-3 text-xs">
              {buttonText}
            </Button>
            {onOpenSettings && (
              <Button onClick={onOpenSettings} size="sm" variant="ghost" className="h-7 w-7 p-0">
                <Settings className="w-3.5 h-3.5" />
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
