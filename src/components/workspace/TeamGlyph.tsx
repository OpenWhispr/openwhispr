import type { ReactElement } from "react";
import { Users } from "../icons";
import { TileGlyph } from "../notes/SpaceNameField";

// What a team's tile shows: its emoji when it has one, else the people glyph the frames draw.
export function TeamGlyph({
  emoji,
  name,
}: {
  emoji: string | null | undefined;
  name: string;
}): ReactElement {
  return emoji ? (
    <TileGlyph emoji={emoji} name={name} />
  ) : (
    <Users className="size-3.5 text-muted-foreground" />
  );
}
