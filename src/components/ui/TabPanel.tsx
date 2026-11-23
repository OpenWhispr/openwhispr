import type { ReactNode, Ref } from "react";
import { PanelVisibleProvider, usePanelVisible } from "./usePanelVisible";

/**
 * Keeps an inactive tab mounted but hidden, and tells what it holds whether it is shown,
 * so a hidden panel's checks wait. A tab is shown only while every TabPanel around it is
 * active.
 */
export function TabPanel({
  active,
  children,
  ref,
}: {
  active: boolean;
  children: ReactNode;
  ref?: Ref<HTMLDivElement>;
}) {
  const shown = usePanelVisible() && active;
  return (
    <div hidden={!active} ref={ref}>
      <PanelVisibleProvider value={shown}>{children}</PanelVisibleProvider>
    </div>
  );
}
