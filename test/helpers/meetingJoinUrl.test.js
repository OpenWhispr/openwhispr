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
