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

test("schedule refresh clears a no-longer-eligible cached meeting", (t) => {
  const event = activeEvent("google", "meeting");
  let rows = [event];
  // Not started yet: the reminder fires in the minute before start.
  let active = [];
  const scheduler = new CalendarReminderScheduler({
    getUpcomingEvents: () => rows,
    getActiveEvents: () => active,
  });
  t.after(() => scheduler.stop());
  let prompts = 0;
  scheduler.meetingDetectionEngine = { handleCalendarReminder: () => prompts++ };
  scheduler.scheduleNextMeeting();
  assert.equal(prompts, 1);
  assert.ok(scheduler.meetingEndTimer);
  rows = [];
  scheduler.scheduleNextMeeting();
  assert.equal(scheduler.activeMeeting, null);
  assert.equal(scheduler.meetingEndTimer, null);
  assert.equal(prompts, 1);
  rows = [event];
  scheduler.scheduleNextMeeting();
  assert.equal(prompts, 1, "reacceptance cannot repeat a delivered reminder");
  assert.equal(scheduler.activeMeeting, event);
  active = rows;
  scheduler.onWakeFromSleep();
  assert.equal(prompts, 1, "waking after the start cannot repeat it either");
});

test("clearing the cached meeting restores another reminded running meeting", (t) => {
  const first = activeEvent("apple", "first");
  const second = activeEvent("apple", "second");
  let rows = [first];
  const scheduler = new CalendarReminderScheduler({
    getUpcomingEvents: () => rows,
    getActiveEvents: () => rows,
  });
  t.after(() => scheduler.stop());
  let prompts = 0;
  scheduler.meetingDetectionEngine = { handleCalendarReminder: () => prompts++ };
  scheduler.scheduleNextMeeting();
  rows = [first, second];
  scheduler.scheduleNextMeeting();
  assert.equal(scheduler.activeMeeting, second);
  rows = [first];
  scheduler.scheduleNextMeeting();
  assert.equal(scheduler.activeMeeting, first);
  scheduler.onWakeFromSleep();
  assert.equal(prompts, 2, "waking cannot repeat a delivered reminder");
});

// Calendar.app mirrors Google and Microsoft accounts. The database hides the
// Apple copy once the REST copy is stored, which can be after the reminder.
function mirroredMeeting() {
  const appleCopy = activeEvent("apple", "apple-1");
  const restCopy = {
    ...appleCopy,
    id: "google-1",
    provider: "google",
    // Google stores offset-form timestamps; the instants match.
    start_time: appleCopy.start_time.replace("Z", "+00:00"),
    end_time: appleCopy.end_time.replace("Z", "+00:00"),
  };
  return { appleCopy, restCopy };
}

function schedulerOver(initialEvents) {
  const state = { events: initialEvents };
  const scheduler = new CalendarReminderScheduler({
    getUpcomingEvents: () => state.events,
    getActiveEvents: () => state.events,
  });
  const reminded = [];
  scheduler.meetingDetectionEngine = {
    handleCalendarReminder: (event) => reminded.push(event.id),
  };
  return { scheduler, reminded, state };
}

test("a meeting reminded from its Apple copy is not reminded again when the REST copy syncs", () => {
  const { appleCopy, restCopy } = mirroredMeeting();
  const { scheduler, reminded, state } = schedulerOver([appleCopy]);

  scheduler.scheduleNextMeeting();
  // The next Google sync stores the REST copy and refreshes the schedule.
  state.events = [restCopy];
  scheduler.scheduleNextMeeting();

  assert.deepEqual(reminded, ["apple-1"]);
  assert.equal(scheduler.activeMeeting.id, "google-1", "notes link the copy the app shows");
  scheduler.stop();
});

test("a meeting reminded from its REST copy is not reminded again from the Apple copy", () => {
  const { appleCopy, restCopy } = mirroredMeeting();
  const { scheduler, reminded, state } = schedulerOver([restCopy]);

  scheduler.scheduleNextMeeting();
  // The REST copy is cancelled, so the database stops hiding the Apple copy.
  state.events = [appleCopy];
  scheduler.scheduleNextMeeting();

  assert.deepEqual(reminded, ["google-1"]);
  scheduler.stop();
});

test("Google and Microsoft meetings in one slot are separate meetings", () => {
  const { restCopy } = mirroredMeeting();
  const outlookMeeting = { ...restCopy, id: "microsoft-1", provider: "microsoft" };
  const { scheduler, reminded } = schedulerOver([restCopy, outlookMeeting]);

  scheduler.scheduleNextMeeting();

  assert.deepEqual(reminded, ["google-1", "microsoft-1"]);
  scheduler.stop();
});

test("disconnecting the reminded copy's provider does not remind its mirror again", () => {
  for (const [first, mirror] of [
    ["restCopy", "appleCopy"],
    ["appleCopy", "restCopy"],
  ]) {
    const copies = mirroredMeeting();
    const { scheduler, reminded, state } = schedulerOver([copies[first]]);

    scheduler.scheduleNextMeeting();
    state.events = [copies[mirror]];
    scheduler.reset(copies[first].provider);

    assert.deepEqual(reminded, [copies[first].id], `${mirror} after ${first}`);
    scheduler.stop();
  }
});
