import type { ReactElement } from "react";
import teamsDark from "../../assets/workspace-empty-teams-dark.webp";
import teamsLight from "../../assets/workspace-empty-teams-light.webp";
import teamspacesDark from "../../assets/workspace-empty-teamspaces-dark.webp";
import teamspacesLight from "../../assets/workspace-empty-teamspaces-light.webp";
import guestsDark from "../../assets/workspace-empty-guests-dark.webp";
import guestsLight from "../../assets/workspace-empty-guests-light.webp";

export type EmptyStateKind = "teams" | "teamspaces" | "guests";

const ART: Record<EmptyStateKind, { dark: string; light: string }> = {
  teams: { dark: teamsDark, light: teamsLight },
  teamspaces: { dark: teamspacesDark, light: teamspacesLight },
  guests: { dark: guestsDark, light: guestsLight },
};

const SIZE = 184;

/**
 * The illustration above a workspace page's empty state: the design's orbit, with a transparent
 * background that fades into the page. It has a light and a dark take, and the `dark` class on the
 * root picks one. Decorative: the title and body beside it say what the page is.
 */
export function EmptyStateArt({ kind }: { kind: EmptyStateKind }): ReactElement {
  const { dark, light } = ART[kind];
  const shared = "pointer-events-none select-none";
  return (
    <>
      <img
        src={light}
        alt=""
        aria-hidden="true"
        width={SIZE}
        height={SIZE}
        decoding="async"
        draggable={false}
        className={`${shared} dark:hidden`}
      />
      <img
        src={dark}
        alt=""
        aria-hidden="true"
        width={SIZE}
        height={SIZE}
        decoding="async"
        draggable={false}
        className={`${shared} hidden dark:block`}
      />
    </>
  );
}
