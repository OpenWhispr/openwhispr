import { useState, type FocusEvent } from "react";

/**
 * True when a blur only means the window lost focus: the page's focus is still inside the
 * element, and the user is coming back to it.
 */
export function isWindowSwitchBlur(event: FocusEvent<HTMLElement>) {
  const element = event.currentTarget;
  return element.contains(element.ownerDocument.activeElement);
}

/**
 * Held from the moment focus enters an element until it really leaves. A window switch
 * keeps it, and so does focus moving to another field inside the element, so one hold can
 * cover a group of fields. Settings uses it to hold a half-typed server address, and to
 * keep the check's pause only while credentials are being typed.
 */
export function useFocusHold() {
  const [held, setHeld] = useState(false);
  return {
    held,
    onFocus: () => setHeld(true),
    onBlur: (event: FocusEvent<HTMLElement>) => {
      if (isWindowSwitchBlur(event)) return;
      if (event.currentTarget.contains(event.relatedTarget)) return;
      setHeld(false);
    },
  };
}
