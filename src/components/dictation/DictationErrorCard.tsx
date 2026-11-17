import { useLayoutEffect, useRef } from "react";
import { ASSISTANT_PANEL_SIZE_LIMITS } from "../../helpers/voiceSurfaceGeometry.mjs";
import { ToastCard, type ToastCardProps } from "../ui/ToastCard";

type DictationErrorCardProps = Omit<ToastCardProps, "children" | "ref"> & {
  onPreferredHeightChange?: (height: number) => void;
};

/** The toast card in the floating dictation window, which sizes its window to the card. */
export function DictationErrorCard({
  onPreferredHeightChange,
  role = "alert",
  ...cardProps
}: DictationErrorCardProps) {
  const cardRef = useRef<HTMLElement | null>(null);
  const lastPreferredHeightRef = useRef(0);

  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card || !onPreferredHeightChange) return;
    const stack = card.closest<HTMLElement>("[data-toast-stack]");

    let frame = 0;
    const measure = () => {
      frame = 0;
      // The card first mounts inside the compact pill window. Wait until the
      // native window has established its final error width so wrapping is
      // measured once at the width the user will actually see.
      const availableSurfaceWidth = Math.max(
        1,
        window.screen.availWidth - ASSISTANT_PANEL_SIZE_LIMITS.gutter
      );
      const availableSurfaceHeight = Math.max(
        1,
        window.screen.availHeight - ASSISTANT_PANEL_SIZE_LIMITS.gutter
      );
      const expectedWidth = Math.min(
        ASSISTANT_PANEL_SIZE_LIMITS.ratioWidth,
        availableSurfaceWidth,
        Math.floor(
          availableSurfaceHeight *
            (ASSISTANT_PANEL_SIZE_LIMITS.ratioWidth / ASSISTANT_PANEL_SIZE_LIMITS.ratioHeight)
        )
      );
      if (Math.abs(card.getBoundingClientRect().width - expectedWidth) > 1) return;
      // Standard toasts stack above the card, and the window has to fit them too
      // or the bottom-anchored stack pushes the card out of its top.
      const stackedToastsHeight = stack ? stack.offsetHeight - card.offsetHeight : 0;
      const preferredHeight = Math.ceil(
        Math.max(card.offsetHeight, card.scrollHeight) + stackedToastsHeight
      );
      if (Math.abs(preferredHeight - lastPreferredHeightRef.current) < 1) return;
      lastPreferredHeightRef.current = preferredHeight;
      onPreferredHeightChange(preferredHeight);
    };
    const scheduleMeasure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };

    const resizeObserver = new ResizeObserver(scheduleMeasure);
    resizeObserver.observe(card);
    if (stack) resizeObserver.observe(stack);
    scheduleMeasure();

    return () => {
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
    };
  }, [onPreferredHeightChange]);

  return <ToastCard ref={cardRef} role={role} {...cardProps} />;
}
