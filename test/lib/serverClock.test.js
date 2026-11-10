const test = require("node:test");
const assert = require("node:assert/strict");

const {
  recordServerDate,
  resetServerClock,
  serverClockOffsetMs,
  serverTimeIso,
} = require("../../src/lib/serverClock.ts");

test.beforeEach(() => resetServerClock());

test("without a Date header yet, server time is the device's own", () => {
  assert.equal(serverClockOffsetMs(), null);
  const at = Date.parse("2026-11-10T12:00:00.000Z");
  assert.equal(serverTimeIso(at), "2026-11-10T12:00:00.000Z");
});

test("a device an hour fast stamps its times an hour back", () => {
  recordServerDate("Tue, 10 Nov 2026 12:00:00 GMT", Date.parse("2026-11-10T13:00:00.400Z"));
  assert.equal(serverClockOffsetMs(), -(60 * 60 * 1000 + 400));
  assert.equal(serverTimeIso(Date.parse("2026-11-10T13:05:00.000Z")), "2026-11-10T12:04:59.600Z");
});

test("server time never runs ahead of the server: the header's lost fraction counts against it", () => {
  // The server answered at 12:00:00.900 by its clock; its header says 12:00:00.
  const answeredAt = Date.parse("2026-11-10T12:00:00.900Z");
  recordServerDate("Tue, 10 Nov 2026 12:00:00 GMT", answeredAt);
  assert.ok(Date.parse(serverTimeIso(answeredAt)) <= answeredAt);
});

test("the latest answer wins, so a corrected device clock is picked up", () => {
  recordServerDate("Tue, 10 Nov 2026 12:00:00 GMT", Date.parse("2026-11-10T13:00:00.000Z"));
  recordServerDate("Tue, 10 Nov 2026 12:10:00 GMT", Date.parse("2026-11-10T12:10:00.000Z"));
  assert.equal(serverClockOffsetMs(), 0);
});

test("a missing or unreadable header changes nothing", () => {
  recordServerDate("Tue, 10 Nov 2026 12:00:00 GMT", Date.parse("2026-11-10T12:00:02.000Z"));
  recordServerDate(undefined, Date.now());
  recordServerDate("", Date.now());
  recordServerDate("not a date", Date.now());
  assert.equal(serverClockOffsetMs(), -2000);
});
