import { Button } from "./button";
import { Check, IconComponent } from "../icons";
import { cn } from "../lib/utils";

interface PermissionCardProps {
  icon: IconComponent;
  title: string;
  description: string;
  granted: boolean;
  onRequest: () => void;
  buttonText?: string;
  badge?: string;
  hint?: string;
}

export default function PermissionCard({
  icon: Icon,
  title,
  description,
  granted,
  onRequest,
  buttonText = "Grant Access",
  badge,
  hint,
}: PermissionCardProps) {
  return (
    <div
      className={cn(
        "group relative rounded-md p-3 transition-colors duration-150",
        "border",
        granted
          ? "bg-green-solid/5 border-green-solid/20 dark:border-green-solid/15"
          : "bg-surface-secondary border-default hover:bg-surface-primary hover:border-hover"
      )}
    >
      <div className="flex items-center gap-3">
        <div
          className={cn(
            "w-8 h-8 rounded-md flex items-center justify-center shrink-0 transition-colors duration-150",
            granted
              ? "bg-green-solid/10 dark:bg-green-solid/15"
              : "bg-brand-solid/10 dark:bg-brand-solid/15 group-hover:bg-brand-solid/15"
          )}
        >
          {granted ? (
            <Check className="w-4 h-4 text-green-solid" strokeWidth={2.5} />
          ) : (
            <Icon className="w-4 h-4 text-brand-solid" />
          )}
        </div>

        <div className="flex-1 min-w-0">
          <h3 className="text-xs font-medium text-primary">
            {title}
            {badge && (
              <span className="ms-1.5 inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded bg-surface-secondary text-secondary">
                {badge}
              </span>
            )}
          </h3>
          <p className="text-xs text-secondary leading-snug mt-0.5">{description}</p>
        </div>

        {!granted && (
          <Button onClick={onRequest} size="sm" className="h-7 px-3 text-xs shrink-0">
            {buttonText}
          </Button>
        )}
      </div>

      {hint && !granted && (
        <p className="text-[11px] text-amber/80 leading-snug mt-2 ps-11">{hint}</p>
      )}
    </div>
  );
}
