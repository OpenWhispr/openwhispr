import { useState, type ReactNode, type Ref } from "react";

export function TabPanel({
  active,
  children,
  ref,
}: {
  active: boolean;
  children: ReactNode;
  ref?: Ref<HTMLDivElement>;
}) {
  return (
    <div hidden={!active} ref={ref}>
      {children}
    </div>
  );
}

/** Mounts children on first activation, then keeps them mounted (hidden) for the owner's lifetime. */
export function KeepAlive({ active, children }: { active: boolean; children: ReactNode }) {
  const [mounted, setMounted] = useState(active);
  if (active && !mounted) setMounted(true);
  return mounted ? <TabPanel active={active}>{children}</TabPanel> : null;
}
