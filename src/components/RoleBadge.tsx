import { cn } from "./lib/utils";

export default function RoleBadge({
  label,
  highlight = false,
}: {
  label: string;
  highlight?: boolean;
}) {
  return (
    <span
      className={cn(
        "text-[10px] font-medium px-2 py-0.5 rounded-md uppercase tracking-wide",
        highlight ? "bg-primary/10 text-primary" : "bg-foreground/6 text-foreground/65"
      )}
    >
      {label}
    </span>
  );
}
