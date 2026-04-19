import { useState, useCallback } from "react";
import { Copy, Check } from "lucide-react";

interface CopyableCommandProps {
  command: string;
  label?: string;
  className?: string;
}

export function CopyableCommand({ command, label, className = "" }: CopyableCommandProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard
      .writeText(command)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => {});
  }, [command]);

  return (
    <div className={className}>
      {label && <div className="text-xs text-muted-foreground mb-1">{label}</div>}
      <div className="relative bg-card border border-border p-3 rounded-md font-mono text-xs overflow-x-auto">
        <span className="text-foreground pr-8">{command}</span>
        <button
          type="button"
          onClick={handleCopy}
          aria-label={copied ? "Copied" : "Copy command"}
          className="absolute top-2 right-2 h-6 w-6 flex items-center justify-center rounded text-muted-foreground/40 hover:text-muted-foreground hover:bg-muted/50 active:scale-95 transition-all"
        >
          {copied ? (
            <Check className="w-3.5 h-3.5 text-success" />
          ) : (
            <Copy className="w-3.5 h-3.5" />
          )}
        </button>
      </div>
    </div>
  );
}
