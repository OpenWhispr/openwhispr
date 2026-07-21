const test = require("node:test");
const assert = require("node:assert/strict");

const CalendarReminderScheduler = require("../../src/helpers/calendarReminderScheduler.js");

function activeEvent(provider, id) {
  const now = Date.now();
  return {
    id,
    provider,
    summary: `${provider} meeting`,
    start_time: new Date(now - 1000).toISOString(),
    end_time: new Date(now + 60_000).toISOString(),
  };
}

test("resetting one provider preserves reminders delivered by another provider", () => {
  const googleEvent = activeEvent("google", "meeting-1");
  const databaseManager = {
    getUpcomingEvents: () => [googleEvent],
    getActiveEvents: () => [googleEvent],
  };
  const scheduler = new CalendarReminderScheduler(databaseManager);
  let promptCount = 0;
  scheduler.meetingDetectionEngine = {
    handleCalendarReminder: () => {
      promptCount += 1;
    },
  };

  scheduler.scheduleNextMeeting();
  scheduler.reset("apple");
  scheduler.scheduleNextMeeting();

  assert.equal(promptCount, 1);
  assert.equal(scheduler.activeMeeting, googleEvent);
  scheduler.stop();
});

test("resetting a provider lets that provider's remaining event be re-armed", () => {
  const appleEvent = activeEvent("apple", "meeting-1");
  const databaseManager = {
    getUpcomingEvents: () => [appleEvent],
    getActiveEvents: () => [appleEvent],
  };
  const scheduler = new CalendarReminderScheduler(databaseManager);
  let promptCount = 0;
  scheduler.meetingDetectionEngine = {
    handleCalendarReminder: () => {
      promptCount += 1;
    },
  };

  scheduler.scheduleNextMeeting();
  scheduler.reset("apple");
  scheduler.scheduleNextMeeting();

  assert.equal(promptCount, 2);
  scheduler.stop();
});
