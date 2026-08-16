import { cn } from "../lib/utils";
import { AgentModeIcon } from "./AgentModeIcon";
import { BrandMarkIcon } from "./BrandMarkIcon";

interface VoiceIdentityIconProps {
  size?: number;
  agentMode?: boolean;
  className?: string;
}

/** One stable icon box whose two SVG glyphs morph as Agent Mode takes ownership. */
export function VoiceIdentityIcon({
  size = 24,
  agentMode = false,
  className,
}: VoiceIdentityIconProps) {
  return (
    <span
      className={cn("voice-identity-icon relative inline-block shrink-0", className)}
      style={{ width: size, height: size }}
      data-agent-mode={agentMode || undefined}
      aria-hidden="true"
    >
      <BrandMarkIcon
        size={size}
        className="voice-identity-glyph voice-identity-glyph-default absolute inset-0"
      />
      <AgentModeIcon
        size={size}
        className="voice-identity-glyph voice-identity-glyph-agent absolute inset-0 text-agent-brand"
      />
    </span>
  );
}
