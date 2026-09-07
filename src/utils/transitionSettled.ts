// Chain choreography on the browser's own "this transition finished" event,
// with a timeout only as a safety net (reduced motion, a torn-down node, a
// property that never changed). Always unsubscribes.
export function waitForTransitionEnd(
  el: EventTarget | null,
  propertyName: string,
  fallbackMs: number
): Promise<"transitionend" | "timeout"> {
  return new Promise((resolve) => {
    if (!el) {
      setTimeout(() => resolve("timeout"), fallbackMs);
      return;
    }
    let done = false;
    const finish = (how: "transitionend" | "timeout") => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      el.removeEventListener("transitionend", onEnd);
      resolve(how);
    };
    const onEnd = (event: Event) => {
      const transition = event as TransitionEvent;
      if (transition.target !== el || transition.propertyName !== propertyName) return;
      finish("transitionend");
    };
    const timer = setTimeout(() => finish("timeout"), fallbackMs);
    el.addEventListener("transitionend", onEnd);
  });
}
