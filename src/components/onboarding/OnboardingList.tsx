import { useLayoutEffect, useRef, type ReactNode } from "react";

interface OnboardingListProps {
  children: ReactNode;
  /** Caps the scroll area. Omit to let the list absorb its parent's height. */
  maxHeightClassName?: string;
  className?: string;
}

/**
 * The onboarding list surface (Figma "Frame 37").
 *
 * Two elements on purpose: the outer box carries the border, radius and vertical
 * padding, the inner one scrolls. Putting the scroll on the bordered box itself
 * clips the scrollbar thumb against its 16px corner radius.
 *
 * Rows are plain children carrying `.onboarding-list-row`, which owns the
 * dividers and the hover highlight (see index.css) — no JS measurement, so the
 * highlight simply moves and clips with its row like any other row background.
 */
export default function OnboardingList({
  children,
  maxHeightClassName = "",
  className = "",
}: OnboardingListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Stay pinned to the bottom across a resize. The list absorbs leftover height,
  // so picking an item adds a chip above and shrinks it — which pushes maxScroll
  // past the current scrollTop and leaves the bottom row half-cut, slicing its
  // hover highlight flat. Re-pinning keeps the last row whole.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const atBottom = () => Math.abs(el.scrollTop + el.clientHeight - el.scrollHeight) < 2;
    let pinned = atBottom();

    const onScroll = () => {
      pinned = atBottom();
    };
    el.addEventListener("scroll", onScroll, { passive: true });

    const observer = new ResizeObserver(() => {
      if (pinned) el.scrollTop = el.scrollHeight;
    });
    observer.observe(el);

    return () => {
      el.removeEventListener("scroll", onScroll);
      observer.disconnect();
    };
  }, []);

  return (
    <div className={`onboarding-list ${className}`}>
      <div
        ref={scrollRef}
        className={`onboarding-list-scroll min-h-0 flex-1 ${maxHeightClassName}`}
      >
        {children}
      </div>
    </div>
  );
}
