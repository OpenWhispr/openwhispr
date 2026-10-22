const debugLogger = require("./debugLogger");
const { getMeetingJoinUrl } = require("./meetingJoinUrl");

const MEETING_REMINDER_LEAD_MS = 60 * 1000;

function notificationKey(event) {
  return `${event.provider || "google"}:${event.id}`;
}

// Calendar.app mirrors Google and Microsoft accounts, and the database hides
// an Apple copy only once its REST copy is stored (dedupedEventsQuery). Pair
// the copies the same way, by time slot and title, so a copy stored after the
// other one's reminder is not reminded again.
function mirrorSlotKey(event) {
  return `${Date.parse(event.start_time)}|${Date.parse(event.end_time)}|${event.summary || ""}`;
}

// A solo event with no invitees and no meeting link is a time block (focus
// time, a personal reminder), not a meeting — every provider syncs those.
function isReminderEligible(event) {
  return event.attendees_count > 0 || getMeetingJoinUrl(event);
}

// Provider-agnostic meeting reminder scheduling. Reads only the shared
// calendar_events table (deduped across providers), so a single scheduler
// serves both calendar managers without double-firing reminders.
class CalendarReminderScheduler {
  constructor(databaseManager) {
    this.databaseManager = databaseManager;
    this.nextMeetingTimer = null;
    this.meetingEndTimer = null;
    this.activeMeeting = null;
    this.notifiedMeetings = new Set();
    // Mirror slot -> notification keys reminded in that slot.
    this.notifiedSlots = new Map();
  }

  _wasNotified(event) {
    if (this.notifiedMeetings.has(notificationKey(event))) return true;
    const isApple = event.provider === "apple";
    for (const key of this.notifiedSlots.get(mirrorSlotKey(event)) ?? []) {
      // REST rows never mirror each other, so only an Apple/REST pair matches.
      if (key.startsWith("apple:") !== isApple) return true;
    }
    return false;
  }

  _markNotified(event) {
    const key = notificationKey(event);
    this.notifiedMeetings.add(key);
    const slot = mirrorSlotKey(event);
    if (!this.notifiedSlots.has(slot)) this.notifiedSlots.set(slot, new Set());
    this.notifiedSlots.get(slot).add(key);
  }

  scheduleNextMeeting() {
    if (this.activeMeeting) {
      this.reconcileProvider(this.activeMeeting.provider);
    }
    if (!this.activeMeeting) {
      // A delivered meeting that became eligible again (re-accepted before or
      // during the meeting) is active again, without a second reminder.
      const delivered = this.databaseManager
        .getUpcomingEvents(1)
        .find((event) => this._wasNotified(event));
      if (delivered) {
        this.activeMeeting = delivered;
        this._scheduleMeetingEnd(delivered);
      }
    }

    if (this.nextMeetingTimer) {
      clearTimeout(this.nextMeetingTimer);
      this.nextMeetingTimer = null;
    }

    const upcoming = this.databaseManager.getUpcomingEvents(1440);
    const next = upcoming.find((event) => isReminderEligible(event) && !this._wasNotified(event));
    if (!next) return;

    const delay = new Date(next.start_time).getTime() - MEETING_REMINDER_LEAD_MS - Date.now();
    if (delay <= 0) {
      this.onMeetingStart(next);
      return;
    }

    this.nextMeetingTimer = setTimeout(() => {
      this.onMeetingStart(next);
    }, delay);
  }

  onMeetingStart(event) {
    if (!isReminderEligible(event)) {
      this.scheduleNextMeeting();
      return;
    }

    const events = this.databaseManager.getActiveEvents();
    const stillExists =
      events.some((e) => notificationKey(e) === notificationKey(event)) ||
      this.databaseManager
        .getUpcomingEvents(1)
        .some((e) => notificationKey(e) === notificationKey(event));

    if (!stillExists) {
      this.scheduleNextMeeting();
      return;
    }

    this.activeMeeting = event;
    this._markNotified(event);

    debugLogger.info("Calendar meeting reminder due", { summary: event.summary }, "calendar");
    this.meetingDetectionEngine?.handleCalendarReminder(event);

    this._scheduleMeetingEnd(event);

    this.scheduleNextMeeting();
  }

  onMeetingEnd() {
    debugLogger.info(
      "Calendar meeting ended",
      { summary: this.activeMeeting?.summary },
      "calendar"
    );
    this.activeMeeting = null;
    this._clearMeetingEndTimer();
    this.scheduleNextMeeting();
  }

  onWakeFromSleep() {
    const activeEvents = this.databaseManager.getActiveEvents();
    if (activeEvents.length > 0 && !this.activeMeeting) {
      this.onMeetingStart(activeEvents[0]);
    }
    this.scheduleNextMeeting();
  }

  getActiveMeetingState() {
    return {
      activeMeeting: this.activeMeeting,
      activeEvents: this.databaseManager.getActiveEvents(),
      upcomingEvents: this.databaseManager.getUpcomingEvents(15),
    };
  }

  // Refresh or clear the cached active event on every schedule refresh. Keep
  // notifiedMeetings intact so periodic snapshots cannot re-fire a reminder
  // that was already delivered.
  reconcileProvider(provider) {
    if (!this.activeMeeting || this.activeMeeting.provider !== provider) return;

    const key = notificationKey(this.activeMeeting);
    const currentEvent = [
      ...this.databaseManager.getActiveEvents(),
      ...this.databaseManager.getUpcomingEvents(1),
    ].find((event) => notificationKey(event) === key);

    if (!currentEvent) {
      this.activeMeeting = null;
      this._clearMeetingEndTimer();
      return;
    }

    this.activeMeeting = currentEvent;
    this._scheduleMeetingEnd(currentEvent);
  }

  _scheduleMeetingEnd(event) {
    this._clearMeetingEndTimer();
    const endDelay = new Date(event.end_time).getTime() - Date.now();
    if (endDelay > 0) {
      this.meetingEndTimer = setTimeout(() => {
        this.onMeetingEnd();
      }, endDelay);
    }
  }

  _clearMeetingEndTimer() {
    if (this.meetingEndTimer) {
      clearTimeout(this.meetingEndTimer);
      this.meetingEndTimer = null;
    }
  }

  stop() {
    if (this.nextMeetingTimer) {
      clearTimeout(this.nextMeetingTimer);
      this.nextMeetingTimer = null;
    }
    this._clearMeetingEndTimer();
    this.activeMeeting = null;
  }

  // Re-arm after one provider's data changes without forgetting reminders
  // already delivered by the other provider.
  reset(provider = null) {
    if (!provider) {
      this.stop();
      this.notifiedMeetings.clear();
      this.notifiedSlots.clear();
      return;
    }

    if (this.nextMeetingTimer) {
      clearTimeout(this.nextMeetingTimer);
      this.nextMeetingTimer = null;
    }

    if (this.activeMeeting?.provider === provider) {
      this.activeMeeting = null;
      this._clearMeetingEndTimer();
    }

    const prefix = `${provider}:`;
    for (const key of this.notifiedMeetings) {
      if (key.startsWith(prefix)) this.notifiedMeetings.delete(key);
    }
    for (const [slot, keys] of this.notifiedSlots) {
      for (const key of keys) if (key.startsWith(prefix)) keys.delete(key);
      if (keys.size === 0) this.notifiedSlots.delete(slot);
    }

    this.scheduleNextMeeting();
  }
}

module.exports = CalendarReminderScheduler;
