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
        highlight ? "bg-brand-solid/10 text-brand-solid" : "bg-text-primary/6 text-primary/65"
      )}
    >
      {label}
    </span>
  );
}
