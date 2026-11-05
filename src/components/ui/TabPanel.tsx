import type { ReactNode } from "react";
import { PanelVisibleProvider, usePanelVisible } from "./usePanelVisible";

/**
 * Keeps an inactive tab mounted but hidden, and tells what it holds whether it is shown,
 * so a hidden panel's checks wait. A tab is shown only while every TabPanel around it is
 * active.
 */
export function TabPanel({ active, children }: { active: boolean; children: ReactNode }) {
  const shown = usePanelVisible() && active;
  return (
    <div className={active ? undefined : "hidden"}>
      <PanelVisibleProvider value={shown}>{children}</PanelVisibleProvider>
    </div>
  );
}
