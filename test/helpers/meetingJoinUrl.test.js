const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/meetingJoinUrl.js");

test("prefers hangout_link when present", async () => {
  const { getMeetingJoinUrl } = await load();
  const event = {
    hangout_link: "https://meet.google.com/abc-defg-hij",
    conference_data: JSON.stringify({
      entryPoints: [{ entryPointType: "video", uri: "https://zoom.us/j/123" }],
    }),
  };
  assert.equal(getMeetingJoinUrl(event), "https://meet.google.com/abc-defg-hij");
});

test("falls back to the video entry point in conference_data", async () => {
  const { getMeetingJoinUrl } = await load();
  const event = {
    conference_data: JSON.stringify({
      entryPoints: [
        { entryPointType: "phone", uri: "tel:+15551234567" },
        { entryPointType: "video", uri: "https://zoom.us/j/123" },
      ],
    }),
  };
  assert.equal(getMeetingJoinUrl(event), "https://zoom.us/j/123");
});

test("returns null without a video entry point", async () => {
  const { getMeetingJoinUrl } = await load();
  const event = {
    conference_data: JSON.stringify({
      entryPoints: [{ entryPointType: "phone", uri: "tel:+15551234567" }],
    }),
  };
  assert.equal(getMeetingJoinUrl(event), null);
});

test("returns null for malformed conference_data", async () => {
  const { getMeetingJoinUrl } = await load();
  assert.equal(getMeetingJoinUrl({ conference_data: "not json" }), null);
});

test("returns null for missing event or links", async () => {
  const { getMeetingJoinUrl } = await load();
  assert.equal(getMeetingJoinUrl(null), null);
  assert.equal(getMeetingJoinUrl({}), null);
});

test("extractMeetingUrl matches known meeting vendors", async () => {
  const { extractMeetingUrl } = await load();
  const urls = [
    "https://zoom.us/j/123456789",
    "https://us02web.zoom.us/j/123456789?pwd=abc",
    "https://zoom.us/w/123456789",
    "https://us02web.zoom.us/w/123456789?pwd=abc",
    "https://zoom.us/my/alice",
    "https://meet.google.com/abc-defg-hij",
    "https://teams.microsoft.com/l/meetup-join/19%3ameeting_x/0",
    "https://teams.microsoft.com/meet/1234567890?p=abc",
    "https://teams.live.com/meet/9876543210",
    "https://company.webex.com/meet/jdoe",
    "https://chime.aws/1234567890",
  ];
  for (const url of urls) {
    assert.equal(extractMeetingUrl([url]), url);
  }
});

test("extractMeetingUrl finds a link inside a location string", async () => {
  const { extractMeetingUrl } = await load();
  assert.equal(
    extractMeetingUrl(["Join here: https://meet.google.com/abc-defg-hij (passcode 42)"]),
    "https://meet.google.com/abc-defg-hij"
  );
  assert.equal(
    extractMeetingUrl(["Zoom: https://zoom.us/j/123456789, dial-in below"]),
    "https://zoom.us/j/123456789"
  );
});

test("extractMeetingUrl rejects meeting paths on untrusted hosts", async () => {
  const { extractMeetingUrl } = await load();
  const urls = [
    "https://attacker.example/teams.microsoft.com/meet/123?p=abc",
    "https://attacker.example/zoom.us/w/123?tk=secret",
    "https://attacker.example/meet.google.com/abc-defg-hij",
    "https://attacker.example/teams.live.com/meet/9876543210",
    "https://attacker.example/company.webex.com/meet/jdoe",
    "https://attacker.example/chime.aws/1234567890",
    "https://attacker.example/?next=https://zoom.us/my/alice",
    "https://zoom.us@attacker.example/w/123",
    "https://zoom.us.attacker.example/w/123",
  ];

  for (const url of urls) {
    assert.equal(extractMeetingUrl([url]), null);
  }
});

test("extractMeetingUrl skips untrusted URLs before a valid meeting URL", async () => {
  const { extractMeetingUrl } = await load();

  assert.equal(
    extractMeetingUrl([
      "Agenda: https://attacker.example/zoom.us/w/123 Join: https://zoom.us/w/456",
    ]),
    "https://zoom.us/w/456"
  );
});

test("extractMeetingUrl rejects unsupported paths on trusted hosts", async () => {
  const { extractMeetingUrl } = await load();
  const urls = [
    "https://zoom.us/profile/alice",
    "https://meet.google.com/",
    "https://teams.microsoft.com/chat/123",
    "https://teams.live.com/chat/123",
    "https://company.webex.com/",
    "https://chime.aws/",
  ];

  for (const url of urls) {
    assert.equal(extractMeetingUrl([url]), null);
  }
});

test("extractMeetingUrl returns the first matching candidate", async () => {
  const { extractMeetingUrl } = await load();
  assert.equal(
    extractMeetingUrl([
      null,
      "Conference Room 4B",
      "https://zoom.us/j/111",
      "https://meet.google.com/zzz",
    ]),
    "https://zoom.us/j/111"
  );
});

test("extractMeetingUrl returns null when nothing matches", async () => {
  const { extractMeetingUrl } = await load();
  assert.equal(extractMeetingUrl([]), null);
  assert.equal(extractMeetingUrl(null), null);
  assert.equal(extractMeetingUrl(undefined), null);
  assert.equal(extractMeetingUrl("not an array"), null);
  assert.equal(extractMeetingUrl([null, undefined, ""]), null);
  assert.equal(extractMeetingUrl(["Conference Room 4B", "https://example.com/agenda"]), null);
});

test("getMeetingJoinUrl trims hangout_link and skips whitespace-only links", async () => {
  const { getMeetingJoinUrl } = await load();

  const eventWithSpace = {
    hangout_link: "  https://meet.google.com/abc-defg-hij  ",
  };
  assert.equal(getMeetingJoinUrl(eventWithSpace), "https://meet.google.com/abc-defg-hij");

  const eventWithWhitespaceOnly = {
    hangout_link: "   ",
    conference_data: JSON.stringify({
      entryPoints: [{ entryPointType: "video", uri: " https://zoom.us/j/123 " }],
    }),
  };
  assert.equal(getMeetingJoinUrl(eventWithWhitespaceOnly), "https://zoom.us/j/123");
});
