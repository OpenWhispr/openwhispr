import type { MeetingAutoEndReason, MeetingNotificationData } from "../types/electron";

type AutoEndBodyKey =
  | "meetingNotification.autoEnd.body.micReleased"
  | "meetingNotification.autoEnd.body.silence"
  | "meetingNotification.autoEnd.body.processExit";

const AUTO_END_BODY_KEYS: Record<MeetingAutoEndReason, AutoEndBodyKey> = {
  "mic-released": "meetingNotification.autoEnd.body.micReleased",
  silence: "meetingNotification.autoEnd.body.silence",
  "process-exit": "meetingNotification.autoEnd.body.processExit",
};

interface AutoEndPresentation {
  titleKey: "meetingNotification.autoEnd.title";
  bodyKey: AutoEndBodyKey;
  bodyValues: { seconds: number };
  actionKey: "meetingNotification.autoEnd.restart";
  action: "restart";
  dismissible: true;
  allowTitleWrap: true;
}

interface DetectionPresentation {
  title?: string;
  titleKey?: "meetingNotification.title";
  bodyKey:
    | "meetingNotification.body.detected"
    | "meetingNotification.body.starting"
    | "meetingNotification.body.underway";
  actionKey: "meetingNotification.start" | "meetingNotification.join";
  action: "start" | "join";
  dismissible: true;
  allowTitleWrap: false;
}

export type MeetingNotificationPresentation = AutoEndPresentation | DetectionPresentation;

const MEETING_NOTIFICATION_SWIPE_DISTANCE_PX = 80;

export function shouldDismissMeetingNotificationSwipe(
  dismissible: boolean,
  horizontalDistance: number
): boolean {
  return dismissible && Math.abs(horizontalDistance) >= MEETING_NOTIFICATION_SWIPE_DISTANCE_PX;
}

export function getMeetingNotificationPresentation(
  data: MeetingNotificationData | null,
  secondsRemaining: number
): MeetingNotificationPresentation {
  if (data?.kind === "auto-end") {
    return {
      titleKey: "meetingNotification.autoEnd.title",
      bodyKey:
        AUTO_END_BODY_KEYS[data.reason ?? "mic-released"] ?? AUTO_END_BODY_KEYS["mic-released"],
      bodyValues: { seconds: secondsRemaining },
      actionKey: "meetingNotification.autoEnd.restart",
      action: "restart",
      dismissible: true,
      allowTitleWrap: true,
    };
  }

  const variant = data?.variant ?? "detected";
  const eventTitle = variant !== "detected" ? data?.event?.summary : null;
  return {
    ...(eventTitle ? { title: eventTitle } : { titleKey: "meetingNotification.title" }),
    bodyKey: `meetingNotification.body.${variant}`,
    actionKey: data?.joinUrl ? "meetingNotification.join" : "meetingNotification.start",
    action: data?.joinUrl ? "join" : "start",
    dismissible: true,
    allowTitleWrap: false,
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

interface CountdownClock {
  now: () => number;
  setInterval: (callback: () => void, delay: number) => ReturnType<typeof setInterval>;
  clearInterval: (timer: ReturnType<typeof setInterval>) => void;
}

const defaultCountdownClock: CountdownClock = {
  now: Date.now,
  setInterval: (callback, delay) => setInterval(callback, delay),
  clearInterval: (timer) => clearInterval(timer),
};

// Main closes the notification window when it accepts a response. Anything
// else — a rejected response, or a preload without the method — leaves the
// window alive, so the optimistically hidden card must be restored.
export function shouldRestoreAutoEndCard(result: { success: boolean } | null | undefined): boolean {
  return result?.success !== true;
}

export function getMeetingAutoEndSecondsRemaining(expiresAt: number, now: number): number {
  return Math.max(0, Math.ceil((expiresAt - now) / 1000));
}

export function subscribeMeetingAutoEndCountdown(
  expiresAt: number,
  onSecondsChanged: (seconds: number) => void,
  clock: CountdownClock = defaultCountdownClock
): () => void {
  const update = (): void => {
    onSecondsChanged(getMeetingAutoEndSecondsRemaining(expiresAt, clock.now()));
  };

  update();
  const timer = clock.setInterval(update, 250);
  return () => clock.clearInterval(timer);
}
