import { useEffect, useState } from "react";
import { ellipsisFrame } from "./localDownloadState";

// One frame every 400ms, so a full stop-to-three-dots cycle takes 1.6s.
const ELLIPSIS_FRAME_MS = 400;

// Installation reports no byte progress, so without this the header sits on a
// full bar and reads as a stalled download. aria-hidden because the tray is an
// aria-live region: an announced dot would re-read the whole strip every frame.
export function AnimatedEllipsis() {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const timer = setInterval(() => setTick((current) => current + 1), ELLIPSIS_FRAME_MS);
    return () => clearInterval(timer);
  }, []);

  return <span aria-hidden="true">{ellipsisFrame(tick)}</span>;
}
