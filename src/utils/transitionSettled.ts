// Chain choreography on the browser's own "this transition finished" event,
// with a timeout only as a safety net (reduced motion, a torn-down node, a
// property that never changed). Always unsubscribes.
//
// An interrupted transition (re-opening mid-close, a recording starting
// during a hide animation) fires `transitioncancel` instead of
// `transitionend` — without handling it, the chain would stall for the
// entire fallback window before continuing, so it's a third settle reason
// here, not a special case callers need to know about.
export function waitForTransitionEnd(
  el: EventTarget | null,
  propertyName: string,
  fallbackMs: number
): Promise<"transitionend" | "transitioncancel" | "timeout"> {
  return new Promise((resolve) => {
    if (!el) {
      setTimeout(() => resolve("timeout"), fallbackMs);
      return;
    }
    let done = false;
    const finish = (how: "transitionend" | "transitioncancel" | "timeout") => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      el.removeEventListener("transitionend", onSettle);
      el.removeEventListener("transitioncancel", onSettle);
      resolve(how);
    };
    const onSettle = (event: Event) => {
      const transition = event as TransitionEvent;
      if (transition.target !== el || transition.propertyName !== propertyName) return;
      finish(event.type === "transitioncancel" ? "transitioncancel" : "transitionend");
    };
    const timer = setTimeout(() => finish("timeout"), fallbackMs);
    el.addEventListener("transitionend", onSettle);
    el.addEventListener("transitioncancel", onSettle);
  });
}

// The convention every waitForTransitionEnd call site uses for its
// fallback: the transition's own pinned CSS duration, plus a grace window
// for event-loop scheduling jitter. One knob here instead of each of the
// ten later tasks open-coding "+120" independently.
const SETTLE_FALLBACK_GRACE_MS = 120;

export function settleFallbackMs(durationMs: number): number {
  return durationMs + SETTLE_FALLBACK_GRACE_MS;
}
