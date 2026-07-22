import { Folder, Lock, Users } from "lucide-react";
import type { SpaceItem, FolderItem } from "../../../types/electron";

interface ContainerIconProps {
  space: SpaceItem;
  folder: FolderItem | null;
  size?: number;
}

export function ContainerIcon({ space, folder, size = 14 }: ContainerIconProps) {
  if (folder) {
    return <Folder size={size} className="text-muted-foreground/60 shrink-0" />;
  }
  if (space.kind === "private") {
    return <Lock size={size} className="text-muted-foreground/60 shrink-0" />;
  }
  if (space.emoji) {
    return (
      <span className="leading-none shrink-0" style={{ fontSize: size }} aria-hidden="true">
        {space.emoji}
      </span>
    );
  }
  return <Users size={size} className="text-muted-foreground/60 shrink-0" />;
}
