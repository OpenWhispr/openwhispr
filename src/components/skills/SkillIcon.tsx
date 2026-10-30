import { useRef, type ReactElement } from "react";
import { SkillStack } from "../icons";
import { cn } from "../lib/utils";
import "../../styles/skill-icon.css";

interface SkillIconProps {
  size?: number;
  className?: string;
  /** Each change after the first render drops the layers in once. */
  playKey?: number;
}

export function SkillIcon({ size, className, playKey = 0 }: SkillIconProps): ReactElement {
  const mountedKey = useRef(playKey);
  const playing = playKey !== mountedKey.current;
  // A new key mounts a new svg, so its animation starts from the first frame.
  return (
    <SkillStack key={playKey} size={size} className={cn(playing && "skill-icon-play", className)} />
  );
}
