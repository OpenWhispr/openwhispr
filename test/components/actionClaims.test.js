const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/components/chat/actionClaims.ts");

test("a reply that says it did something is a claim", async () => {
  const { claimsAction } = await load();
  for (const text of [
    "Done! I've sent a follow-up email to Gabe saying he can ignore the last one.",
    "I've prompted you to connect your calendar.",
    "I sent the message to Chad.",
    "I’ve gone ahead and posted it in #general.",
    "I have scheduled the meeting for 3 PM tomorrow.",
    "I've created the issue for the login bug.",
    "I've added the standup to your calendar.",
    "I've saved it to your notes.",
    "Your email has been sent to Josh.",
    "Gmail has been connected.",
    "✅ Email sent!",
    "Sure.\nMessage posted to #eng.",
    "[Tools used: email_draft (sent)]\n\nDone, it's on its way.",
  ]) {
    assert.equal(claimsAction(text), true, text);
  }
});

test("plans, offers, questions, negations, states and rewrites are not claims", async () => {
  const { claimsAction } = await load();
  for (const text of [
    "I can send it once you confirm.",
    "Gmail is connected.",
    "I'll send it now.",
    "I haven't sent anything yet.",
    "I have not sent it, and I didn't post anything either.",
    "Should I send it to Josh?",
    "Have I sent it? No, the card was cancelled.",
    'Here\'s a friendlier version: "Could you send me the report by Friday?"',
    "I've updated the wording below so it sounds friendlier:",
    "I've rewritten it to be shorter.",
    "I searched your notes and found three meetings with Dana.",
    "Once you approve the card, it will be sent.",
    "The draft is ready for you to review and send.",
    "Your calendar is not connected yet, so I can't check it.",
    "",
  ]) {
    assert.equal(claimsAction(text), false, text);
  }
});

test("what an earlier turn did is a report, not this turn's claim", async () => {
  const { claimsAction } = await load();
  for (const text of [
    "Yes — I sent it earlier in this chat: https://mail.google.com/mail/u/0/#sent",
    "I already sent that email, so I didn't send it again.",
    "I posted it in #eng yesterday.",
  ]) {
    assert.equal(claimsAction(text), false, text);
  }
});

const call = (name, extra = {}) => ({
  id: `call-${name}`,
  name,
  arguments: "{}",
  status: "completed",
  ...extra,
});

test("a claim is backed by an action that happened, or may have", async () => {
  const { backsActionClaim } = await load();
  const action = (status) => call("email_draft", { metadata: { status } });
  for (const status of ["sent", "draft_opened", "unknown", "already_sent"]) {
    assert.equal(backsActionClaim(action(status), false), true, status);
  }
  for (const status of [
    "failed",
    "not_sent",
    "cancelled_by_user",
    "needs_clarification",
    "unavailable",
  ]) {
    assert.equal(backsActionClaim(action(status), false), false, status);
  }
  // A call that failed or never finished backs nothing.
  assert.equal(backsActionClaim(call("create_note", { status: "error" }), false), false);
  assert.equal(backsActionClaim(call("create_note", { status: "stopped" }), false), false);
});

test("a finished connection or saved key backs a claim; a dismissed card doesn't", async () => {
  const { backsActionClaim } = await load();
  const asked = (result) =>
    call("request_connection", {
      interaction: { payload: { kind: "connection", target: "gmail" }, state: "settled", result },
    });
  assert.equal(backsActionClaim(asked({ status: "connected", target: "gmail" }), true), true);
  assert.equal(backsActionClaim(asked({ status: "saved" }), true), true);
  assert.equal(backsActionClaim(asked({ status: "done" }), true), true);
  assert.equal(backsActionClaim(asked({ status: "done", ready: false }), true), false);
  assert.equal(backsActionClaim(asked({ status: "cancelled" }), true), false);
  assert.equal(backsActionClaim(asked({ status: "answered", answers: {} }), true), false);
  // A send that connected first is judged by the send.
  const connectedThenFailed = {
    ...asked({ status: "connected", target: "slack" }),
    name: "slack_send_message",
    metadata: { status: "failed" },
  };
  assert.equal(backsActionClaim(connectedThenFailed, false), false);
});

test("a tool that changes something backs a claim; a lookup doesn't", async () => {
  const { backsActionClaim } = await load();
  assert.equal(backsActionClaim(call("update_note", { metadata: { id: 3 } }), false), true);
  assert.equal(backsActionClaim(call("search_notes", { metadata: [{ id: 3 }] }), true), false);
  assert.equal(backsActionClaim(call("get_calendar_events"), true), false);
});
