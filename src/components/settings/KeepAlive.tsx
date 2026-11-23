import { useState, type ReactNode } from "react";
import { TabPanel } from "../ui/TabPanel";

export { TabPanel };

/** Mounts children on first activation, then keeps them mounted (hidden) for the owner's lifetime. */
export function KeepAlive({ active, children }: { active: boolean; children: ReactNode }) {
  const [mounted, setMounted] = useState(active);
  if (active && !mounted) setMounted(true);
  return mounted ? <TabPanel active={active}>{children}</TabPanel> : null;
}
