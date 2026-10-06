import type { MeetingNotificationData } from "../types/electron";

export interface MeetingNotificationPresentation {
  title?: string;
  titleKey?: "meetingNotification.title";
  bodyKey:
    | "meetingNotification.body.detected"
    | "meetingNotification.body.starting"
    | "meetingNotification.body.underway";
  actionKey: "meetingNotification.start" | "meetingNotification.join";
  action: "start" | "join";
  dismissible: true;
}

const MEETING_NOTIFICATION_SWIPE_DISTANCE_PX = 80;

export function shouldDismissMeetingNotificationSwipe(
  dismissible: boolean,
  horizontalDistance: number
): boolean {
  return dismissible && Math.abs(horizontalDistance) >= MEETING_NOTIFICATION_SWIPE_DISTANCE_PX;
}

export function getMeetingNotificationPresentation(
  data: MeetingNotificationData | null
): MeetingNotificationPresentation {
  const variant = data?.variant ?? "detected";
  const eventTitle = variant !== "detected" ? data?.event?.summary : null;
  return {
    ...(eventTitle ? { title: eventTitle } : { titleKey: "meetingNotification.title" }),
    bodyKey: `meetingNotification.body.${variant}`,
    actionKey: data?.joinUrl ? "meetingNotification.join" : "meetingNotification.start",
    action: data?.joinUrl ? "join" : "start",
    dismissible: true,
  };
}

interface MeetingNotificationInitializationOptions {
  subscribe: (callback: (data: MeetingNotificationData) => void) => (() => void) | undefined;
  getPendingData: () => Promise<MeetingNotificationData | null>;
  onData: (data: MeetingNotificationData) => void;
  onVisible: () => void;
  onReady: () => void;
  setTimeout?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void;
}

export function initializeMeetingNotificationOverlay({
  subscribe,
  getPendingData,
  onData,
  onVisible,
  onReady,
  setTimeout: schedule = (callback, delay) => setTimeout(callback, delay),
  clearTimeout: cancel = (timer) => clearTimeout(timer),
}: MeetingNotificationInitializationOptions): () => void {
  let active = true;
  let shown = false;
  let revealTimer: ReturnType<typeof setTimeout> | null = null;

  const show = (data: MeetingNotificationData): void => {
    if (!active || shown) return;
    shown = true;
    onData(data);
    revealTimer = schedule(() => {
      revealTimer = null;
      if (!active) return;
      onVisible();
      onReady();
    }, 50);
  };

  const unsubscribe = subscribe(show);
  void getPendingData()
    .then((data) => {
      if (data) show(data);
    })
    .catch(() => undefined);

  return () => {
    active = false;
    unsubscribe?.();
    if (revealTimer !== null) {
      cancel(revealTimer);
      revealTimer = null;
    }
  };
}
