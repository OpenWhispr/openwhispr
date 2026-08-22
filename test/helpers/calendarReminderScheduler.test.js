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
    attendees_count: 1,
  };
}

const MEETING_LINK_BY_PROVIDER = {
  google: "https://meet.google.com/abc-defg-hij",
  microsoft: "https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc",
  apple: "https://example.zoom.us/j/123456789",
};

for (const provider of Object.keys(MEETING_LINK_BY_PROVIDER)) {
  test(`does not remind for a ${provider} time block without attendees or a meeting link`, () => {
    const timeBlock = activeEvent(provider, "time-block");
    timeBlock.attendees_count = 0;
    const databaseManager = {
      getUpcomingEvents: () => [timeBlock],
      getActiveEvents: () => [timeBlock],
    };
    const scheduler = new CalendarReminderScheduler(databaseManager);
    let promptCount = 0;
    scheduler.meetingDetectionEngine = {
      handleCalendarReminder: () => {
        promptCount += 1;
      },
    };

    scheduler.scheduleNextMeeting();

    assert.equal(promptCount, 0);
    scheduler.stop();
  });

  test(`reminds for a ${provider} time block with a meeting link`, () => {
    const timeBlock = activeEvent(provider, "meet-block");
    timeBlock.attendees_count = 0;
    timeBlock.hangout_link = MEETING_LINK_BY_PROVIDER[provider];
    const databaseManager = {
      getUpcomingEvents: () => [timeBlock],
      getActiveEvents: () => [timeBlock],
    };
    const scheduler = new CalendarReminderScheduler(databaseManager);
    let promptCount = 0;
    scheduler.meetingDetectionEngine = {
      handleCalendarReminder: () => {
        promptCount += 1;
      },
    };

    scheduler.scheduleNextMeeting();

    assert.equal(promptCount, 1);
    scheduler.stop();
  });

  // onWakeFromSleep hands the first active event straight to onMeetingStart,
  // bypassing the scheduleNextMeeting filter.
  test(`waking during a ${provider} time block does not remind`, () => {
    const timeBlock = activeEvent(provider, "time-block");
    timeBlock.attendees_count = 0;
    const databaseManager = {
      getUpcomingEvents: () => [timeBlock],
      getActiveEvents: () => [timeBlock],
    };
    const scheduler = new CalendarReminderScheduler(databaseManager);
    let promptCount = 0;
    scheduler.meetingDetectionEngine = {
      handleCalendarReminder: () => {
        promptCount += 1;
      },
    };

    scheduler.onWakeFromSleep();

    assert.equal(promptCount, 0);
    assert.equal(scheduler.activeMeeting, null);
    scheduler.stop();
  });
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

test("reconciling a provider clears an active event removed by a snapshot", () => {
  const appleEvent = activeEvent("apple", "meeting-1");
  let activeEvents = [appleEvent];
  const databaseManager = {
    getUpcomingEvents: () => activeEvents,
    getActiveEvents: () => activeEvents,
  };
  const scheduler = new CalendarReminderScheduler(databaseManager);
  let promptCount = 0;
  scheduler.meetingDetectionEngine = {
    handleCalendarReminder: () => {
      promptCount += 1;
    },
  };

  scheduler.scheduleNextMeeting();
  activeEvents = [];
  scheduler.reconcileProvider("apple");

  assert.equal(promptCount, 1);
  assert.equal(scheduler.activeMeeting, null);

  activeEvents = [appleEvent];
  scheduler.scheduleNextMeeting();
  assert.equal(promptCount, 1, "a periodic snapshot must not re-fire an old reminder");
  scheduler.stop();
});

test("resetting a provider re-arms the next meeting timer for upcoming events", () => {
  const futureEvent = {
    id: "meeting-future",
    provider: "google",
    summary: "Future meeting",
    start_time: new Date(Date.now() + 600_000).toISOString(),
    end_time: new Date(Date.now() + 1200_000).toISOString(),
    attendees_count: 1,
  };
  const databaseManager = {
    getUpcomingEvents: () => [futureEvent],
    getActiveEvents: () => [],
  };
  const scheduler = new CalendarReminderScheduler(databaseManager);

  scheduler.scheduleNextMeeting();
  assert.notEqual(scheduler.nextMeetingTimer, null);

  scheduler.reset("apple");
  assert.notEqual(
    scheduler.nextMeetingTimer,
    null,
    "reset(provider) must re-arm the next meeting timer"
  );

  scheduler.stop();
});
