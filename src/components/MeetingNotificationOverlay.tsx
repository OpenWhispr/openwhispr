import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from "react";
import { useTranslation } from "react-i18next";
import type {
  MeetingNotificationData,
  MeetingDestinationContext,
  MeetingError,
  MeetingFolderRef,
  MeetingSurfaceState,
} from "../types/electron";
import { MeetingNotificationCard } from "./MeetingNotificationCard";
import { MeetingNotificationFolderPicker } from "./MeetingNotificationFolderPicker";
import { meetingFolderLabel } from "./meetingFolderLabel";
import { Check, ChevronDown } from "./icons";
import "../styles/meeting-notification.css";
import {
  getMeetingNotificationPresentation,
  initializeMeetingNotificationOverlay,
  shouldDismissMeetingNotificationSwipe,
} from "./meetingNotificationModel";

interface PointerSwipe {
  pointerId: number;
  startX: number;
}

// Distance over which a dragged card fades to its minimum opacity.
const SWIPE_FADE_DISTANCE_PX = 240;
const SWIPE_MIN_OPACITY = 0.4;

export default function MeetingNotificationOverlay(): ReactElement {
  const { t } = useTranslation();
  const [data, setData] = useState<MeetingNotificationData | null>(null);
  const [isVisible, setIsVisible] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  // Live pointer offset while swiping; null when the card is at rest.
  const [dragX, setDragX] = useState<number | null>(null);
  // Which edge the card leaves through: +1 right (also the enter side), -1 left.
  const [exitDirection, setExitDirection] = useState<1 | -1>(1);
  const pointerSwipeRef = useRef<PointerSwipe | null>(null);

  const [context, setContext] = useState<MeetingDestinationContext | null>(null);
  const [mode, setMode] = useState<MeetingSurfaceState["mode"]>("closed");
  const [error, setError] = useState<MeetingError | null>(null);
  const [busy, setBusy] = useState(false);
  const [focusReady, setFocusReady] = useState(false);
  const [feedback, setFeedback] = useState<"idle" | "enter" | "hold" | "exit">("idle");
  const [announcement, setAnnouncement] = useState("");
  const [maxHeight, setMaxHeight] = useState(512);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const dataRef = useRef<MeetingNotificationData | null>(null);
  const modeRef = useRef<MeetingSurfaceState["mode"]>("closed");
  const editorGeneration = useRef(0);
  const loadGeneration = useRef(0);
  const layoutRevision = useRef(0);
  const focusGeneration = useRef(0);
  const focusIntent = useRef<MeetingSurfaceState["focus"]>("keep");
  const operation = useRef<object | null>(null);
  const feedbackTimers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const clearFeedback = useCallback(() => {
    feedbackTimers.current.forEach(clearTimeout);
    feedbackTimers.current = [];
    setFeedback("idle");
  }, []);
  const changeMode = useCallback((next: MeetingSurfaceState["mode"], requestFocus = true) => {
    editorGeneration.current++;
    if (next === "closed") {
      focusGeneration.current++;
      focusIntent.current = "release";
      setFocusReady(false);
    } else if (modeRef.current === "closed" && requestFocus) {
      focusGeneration.current++;
      focusIntent.current = "request";
      setFocusReady(false);
    }
    modeRef.current = next;
    setMode(next);
    setError(null);
  }, []);
  const loadContext = useCallback(async () => {
    if (!dataRef.current) return;
    const generation = ++loadGeneration.current;
    try {
      const result = await window.electronAPI.getMeetingNotificationDestination();
      if (generation !== loadGeneration.current) return;
      if (result.success === true) {
        setContext(result.value);
        setError(null);
      } else setError(result.code);
    } catch {
      if (generation === loadGeneration.current) setError("FOLDERS_UNAVAILABLE");
    }
  }, []);
  useEffect(
    () =>
      initializeMeetingNotificationOverlay({
        subscribe: (callback) => window.electronAPI?.onMeetingNotificationData?.(callback),
        getPendingData: () =>
          window.electronAPI?.getMeetingNotificationData?.() ?? Promise.resolve(null),
        onData: (incoming) => {
          dataRef.current = incoming;
          setData(incoming);
          void loadContext();
        },
        onVisible: () => setIsVisible(true),
        onReady: () => {
          void window.electronAPI?.meetingNotificationReady?.();
        },
      }),
    [loadContext]
  );
  useEffect(() => () => feedbackTimers.current.forEach(clearTimeout), []);
  useEffect(() => {
    const offClose = window.electronAPI.onMeetingNotificationSurfaceClosed?.((state) => {
      layoutRevision.current = Math.max(layoutRevision.current, state.revision);
      changeMode("closed", false);
    });
    const offResize = window.electronAPI.onMeetingNotificationSurfaceResized?.((state) => {
      layoutRevision.current = Math.max(layoutRevision.current, state.revision);
    });
    return () => {
      offClose?.();
      offResize?.();
    };
  }, [changeMode]);

  useLayoutEffect(() => {
    if (!data || !surfaceRef.current) return;
    let active = true;
    const report = () => {
      if (!active) return;
      const elements = [
        ...surfaceRef.current!.querySelectorAll<HTMLElement>("[data-meeting-region]"),
      ];
      const regions = elements
        .map((element) => {
          // Layout offsets ignore the entrance/swipe transform, which can put
          // the entire card outside the window before its first visible frame.
          let left = 0;
          let top = 0;
          let parent: HTMLElement | null = element;
          while (parent && parent !== surfaceRef.current) {
            left += parent.offsetLeft;
            top += parent.offsetTop;
            parent = parent.offsetParent as HTMLElement | null;
          }
          const x = Math.max(0, Math.floor(left - 8));
          const y = Math.max(0, Math.floor(top - 8));
          return {
            x,
            y,
            width: Math.max(1, Math.min(416 - x, element.offsetWidth + 16)),
            height: Math.max(1, element.offsetHeight + 16),
          };
        })
        .filter((r) => r.width > 1 && r.height > 1);
      if (!regions.length) regions.push({ x: 4, y: 4, width: 408, height: 76 });
      const height = Math.max(84, ...regions.map((r) => r.y + r.height + 4));
      const focus = focusIntent.current;
      focusIntent.current = "keep";
      const focusEpoch = focusGeneration.current;
      void window.electronAPI
        .setMeetingNotificationSurface({
          revision: ++layoutRevision.current,
          mode: modeRef.current,
          contentHeight: height,
          regions,
          focus,
        })
        .then((result) => {
          if (result.success !== true) return;
          if (result.value.maxHeight) setMaxHeight(result.value.maxHeight);
          if (
            focus === "request" &&
            focusGeneration.current === focusEpoch &&
            modeRef.current !== "closed"
          )
            setFocusReady(true);
        })
        .catch(() => {});
    };
    report();
    const observer = new ResizeObserver(report);
    observer.observe(surfaceRef.current);
    surfaceRef.current
      .querySelectorAll("[data-meeting-region]")
      .forEach((element) => observer.observe(element));
    window.addEventListener("resize", report);
    return () => {
      active = false;
      observer.disconnect();
      window.removeEventListener("resize", report);
    };
  }, [data, mode, context, error]);

  const confirmSelection = useCallback(
    (next: MeetingDestinationContext, ref: MeetingFolderRef) => {
      setContext(next);
      changeMode("closed");
      clearFeedback();
      setFeedback("enter");
      feedbackTimers.current = [
        setTimeout(() => setFeedback("hold"), 200),
        setTimeout(() => setFeedback("exit"), 800),
        setTimeout(() => setFeedback("idle"), 1200),
      ];
      const folder = next.folders.find((f) => f.id === ref.folderId && f.space_id === ref.spaceId);
      if (folder)
        setAnnouncement(
          t("meetingNotification.folders.selected", {
            destination: meetingFolderLabel(next, folder, t),
          })
        );
    },
    [changeMode, clearFeedback, t]
  );
  const choose = useCallback(
    async (
      ref: MeetingFolderRef,
      createRequest?: { requestId: string; name: string; spaceId: number }
    ) => {
      if (!dataRef.current || operation.current) return;
      const op = {};
      operation.current = op;
      setBusy(true);
      setError(null);
      loadGeneration.current++;
      const generation = editorGeneration.current;
      const isCurrent = () => generation === editorGeneration.current;
      try {
        if (createRequest) {
          const created = await window.electronAPI.createMeetingNotificationFolder(createRequest);
          if (!isCurrent()) return;
          if (created.success === false) {
            if (created.context) setContext(created.context);
            setError(created.code);
            return;
          }
          ref = created.value.createdFolder;
          setContext(created.value);
        }
        if (!isCurrent()) return;
        const selected = await window.electronAPI.selectMeetingNotificationFolder(ref);
        if (!isCurrent()) return;
        if (selected.success === true) confirmSelection(selected.value, ref);
        else {
          if (selected.context) setContext(selected.context);
          setError(selected.code);
        }
      } catch {
        if (isCurrent()) setError(createRequest ? "CREATE_FAILED" : "FOLDER_UNAVAILABLE");
      } finally {
        if (operation.current === op) {
          operation.current = null;
          setBusy(false);
        }
      }
    },
    [confirmSelection]
  );

  const presentation = getMeetingNotificationPresentation(data);
  const respond = useCallback(
    async (action: string): Promise<void> => {
      const current = dataRef.current;
      if (!current || operation.current) return;
      const op = {};
      operation.current = op;
      setBusy(true);
      loadGeneration.current++;
      try {
        if (action === "dismiss") {
          // Main closes the window as soon as it handles a dismiss: slide out first.
          setIsVisible(false);
          await new Promise<void>((resolve) => setTimeout(resolve, 200));
        }
        const result = await window.electronAPI?.meetingNotificationRespond?.(
          current.detectionId,
          action,
          context?.existingNote ? { existingNote: context.existingNote } : {}
        );
        // A dismiss that fails leaves nothing to choose, so it never opens the picker.
        if (result?.success === true || action === "dismiss") setIsVisible(false);
        else {
          if (result?.context) setContext(result.context);
          changeMode("list");
          setError(result?.code ?? "START_FAILED");
        }
      } catch {
        if (action === "dismiss") setIsVisible(false);
        else {
          changeMode("list");
          setError("START_FAILED");
        }
      } finally {
        if (operation.current === op) {
          operation.current = null;
          setBusy(false);
        }
      }
    },
    [context, changeMode]
  );

  const dismiss = useCallback((): void => {
    void respond("dismiss");
  }, [respond]);

  const handleMouseEnter = useCallback((): void => {
    setIsHovered(true);
    window.electronAPI?.setNotificationInteractivity?.(true);
  }, []);

  const handleMouseLeave = useCallback((): void => {
    setIsHovered(false);
    // A captured pointer keeps dragging outside the card, so the window has to
    // stay interactive until the swipe finishes.
    if (pointerSwipeRef.current) return;
    window.electronAPI?.setNotificationInteractivity?.(false);
  }, []);

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      if (
        !presentation.dismissible ||
        !isVisible ||
        modeRef.current !== "closed" ||
        operation.current !== null ||
        !event.isPrimary ||
        event.button !== 0 ||
        (event.target instanceof Element && event.target.closest("button,input,form,[role=dialog]"))
      ) {
        return;
      }

      pointerSwipeRef.current = { pointerId: event.pointerId, startX: event.clientX };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [isVisible, presentation.dismissible]
  );

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>): void => {
    const swipe = pointerSwipeRef.current;
    if (!swipe || swipe.pointerId !== event.pointerId) return;
    setDragX(event.clientX - swipe.startX);
  }, []);

  const handlePointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      const swipe = pointerSwipeRef.current;
      if (!swipe || swipe.pointerId !== event.pointerId) return;

      pointerSwipeRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }

      const distance = event.clientX - swipe.startX;
      // Releasing dragX re-enables the transition, so the card either springs
      // back to rest or continues off-screen the way it was already moving.
      setDragX(null);

      // The card may have been replaced mid-drag, so the dismissibility of the
      // card being released is what decides, not the one the swipe started on.
      if (shouldDismissMeetingNotificationSwipe(presentation.dismissible, distance)) {
        setExitDirection(distance < 0 ? -1 : 1);
        dismiss();
      } else if (!isHovered) {
        window.electronAPI?.setNotificationInteractivity?.(false);
      }
    },
    [dismiss, isHovered, presentation.dismissible]
  );

  const handlePointerCancel = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      if (pointerSwipeRef.current?.pointerId !== event.pointerId) return;
      pointerSwipeRef.current = null;
      setDragX(null);
      if (!isHovered) window.electronAPI?.setNotificationInteractivity?.(false);
    },
    [isHovered]
  );

  const title = presentation.title ?? t(presentation.titleKey);
  const body = t(presentation.bodyKey);

  const isDragging = dragX !== null;
  const motionStyle: CSSProperties = isDragging
    ? {
        transform: `translateX(${dragX}px)`,
        opacity: Math.max(
          SWIPE_MIN_OPACITY,
          1 - (Math.abs(dragX) / SWIPE_FADE_DISTANCE_PX) * (1 - SWIPE_MIN_OPACITY)
        ),
      }
    : isVisible
      ? { transform: "translateX(0) scale(1)", opacity: 1 }
      : { transform: `translateX(${exitDirection * 120}%) scale(0.95)`, opacity: 0 };

  return (
    <div
      ref={surfaceRef}
      className="meeting-notification-window relative w-full bg-transparent p-3 select-none"
      onMouseMove={(event) => {
        const interactive =
          Boolean(pointerSwipeRef.current) ||
          (event.target instanceof Element &&
            Boolean(event.target.closest("[data-meeting-region]")));
        void window.electronAPI?.setNotificationInteractivity?.(interactive);
      }}
      style={
        {
          touchAction: presentation.dismissible ? "pan-y" : "auto",
          "--meeting-surface-height": `${maxHeight}px`,
        } as CSSProperties
      }
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
    >
      <div
        className={[
          "will-change-transform",
          isDragging ? "" : "transition-[transform,opacity] duration-300 ease-out",
        ].join(" ")}
        style={motionStyle}
      >
        <div data-meeting-region="card">
          <MeetingNotificationCard
            title={title}
            body={body}
            startLabel={t(presentation.actionKey)}
            onStart={() => void respond(presentation.action)}
            busy={busy}
            dismissLabel={t("meetingNotification.folders.dismiss")}
            picker={
              data ? (
                <button
                  type="button"
                  className={`meeting-folder-trigger feedback-${feedback}`}
                  aria-label={t("meetingNotification.folders.choose")}
                  aria-haspopup="dialog"
                  aria-expanded={mode !== "closed"}
                  disabled={busy}
                  onClick={() => {
                    if (modeRef.current === "closed") {
                      changeMode("list");
                      void loadContext();
                    } else changeMode("closed");
                  }}
                >
                  <ChevronDown className="meeting-folder-chevron size-3" />
                  <Check className="meeting-folder-confirmation size-3" />
                </button>
              ) : undefined
            }
            onDismiss={presentation.dismissible ? dismiss : undefined}
            closeVisible={isHovered}
            onMouseEnter={handleMouseEnter}
            onMouseLeave={handleMouseLeave}
          />
        </div>
        {mode !== "closed" && (
          <MeetingNotificationFolderPicker
            context={context}
            mode={mode}
            busy={busy}
            focusReady={focusReady}
            error={error}
            onMode={changeMode}
            onSelect={(ref) => void choose(ref)}
            onCreate={(request) => void choose({ folderId: 0, spaceId: request.spaceId }, request)}
            onRetry={() => void loadContext()}
          />
        )}
        <span className="sr-only" aria-live="polite">
          {announcement}
        </span>
      </div>
    </div>
  );
}
