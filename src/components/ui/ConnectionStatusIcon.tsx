import "../../styles/connection-status-icon.css";
import { cn } from "../lib/utils";

type ConnectionStatusIconState = "checking" | "connected" | "failed";

/**
 * The status of a field that checks itself: a spinning arc while checking, which closes
 * into a tick on success or a ring with "!" on failure. One SVG changes state in place so
 * the change animates. Decorative: the state must also be given in text.
 */
export function ConnectionStatusIcon({
  state,
  className,
}: {
  state: ConnectionStatusIconState;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      data-state={state}
      className={cn("connection-status-icon", className)}
    >
      <g className="connection-status-icon-spin">
        <circle className="connection-status-icon-ring" cx="12" cy="12" r="9" pathLength={100} />
      </g>
      <path className="connection-status-icon-tick" d="M6.8 12.6l3.4 3.4 7-7.4" pathLength={100} />
      <path className="connection-status-icon-bang" d="M12 7.6v5.2" pathLength={100} />
      <circle className="connection-status-icon-dot" cx="12" cy="16.3" r="1.25" />
    </svg>
  );
}
