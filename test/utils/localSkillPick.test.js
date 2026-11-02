const test = require("node:test");
const assert = require("node:assert/strict");

const fixture = require("../fixtures/skills/local-pick-cases.json");

let pickSkillForRequest;

test.before(async () => {
  ({ pickSkillForRequest } = await import("../../src/utils/localSkillPick.ts"));
});

const summary = ({ name, displayName, description }) => ({
  name,
  displayName,
  description,
  enabled: true,
  valid: true,
  addedAt: "2026-10-01T09:00:00.000Z",
  updatedAt: "2026-10-01T09:00:00.000Z",
  lastUsedAt: null,
});
const skillsFor = (locale, without = []) =>
  fixture.skills[locale].filter((skill) => !without.includes(skill.name)).map(summary);
const pickName = (request, skills) => pickSkillForRequest(request, skills)?.name ?? null;

test("the fixture picks no wrong skill and at least 80% of the right ones", () => {
  const shouldPick = fixture.cases.filter((entry) => entry.expect);
  const wrong = [];
  let right = 0;

  for (const entry of fixture.cases) {
    const picked = pickName(entry.request, skillsFor(entry.locale, entry.without));
    if (picked && picked !== entry.expect) wrong.push(`${entry.request} → ${picked}`);
    if (entry.expect && picked === entry.expect) right += 1;
  }

  assert.deepEqual(wrong, []);
  assert.ok(right / shouldPick.length >= 0.8, `${right} of ${shouldPick.length}`);
});

test("a tie picks nothing", () => {
  const skills = [
    summary({ name: "meeting-prep", displayName: "Meeting prep", description: "Preps me." }),
    summary({ name: "meeting-recap", displayName: "Meeting recap", description: "Sums it up." }),
  ];

  assert.equal(pickName("help with the meeting", skills), null);
  assert.equal(pickName("help with the meeting recap", skills), "meeting-recap");
});

test("one shared word picks nothing", () => {
  const skills = [
    summary({
      name: "weekly-recap",
      displayName: "Weekly recap",
      description: "Writes my recap from this week's notes.",
    }),
  ];

  assert.equal(pickName("open my notes", skills), null, "one description word");
  assert.equal(pickName("recap", skills), null, "one name word");
  assert.equal(pickName("my notes for the recap", skills), "weekly-recap");
});

test("a request that only names a skill's topic picks nothing", () => {
  for (const request of ["is Slack down", "what is Linear", "open Slack", "summary", "reply all"]) {
    assert.equal(pickName(request, skillsFor("en")), null, request);
  }
  for (const request of ["返信", "Slackを開いて"]) {
    assert.equal(pickName(request, skillsFor("ja")), null, request);
  }
});

test("function words in German, Russian and Arabic don't count", () => {
  const reply = summary({
    name: "reply-in-my-voice",
    displayName: "In meinem Stil antworten",
    description:
      "Entwirft Antworten in meinem Schreibstil. Nutze es, wenn ich nicht weiß, was ich schreiben soll.",
  });
  const recap = summary({
    name: "weekly-recap",
    displayName: "ملخص أسبوعي",
    description: "يكتب ملخصي الأسبوعي من ملاحظات هذا الأسبوع. Что это за неделя для меня.",
  });

  assert.equal(pickName("ich bin nicht in meinem Büro", [reply]), null);
  assert.equal(pickName("что это для меня", [recap]), null);
  assert.equal(pickName("ما هو الطقس في هذا الأسبوع", [recap]), null);
  assert.equal(pickName("اكتب ملخص أسبوعي", [recap]), "weekly-recap");
});

test("Japanese requests match without spaces", () => {
  assert.equal(pickName("決定事項ログに追加して", skillsFor("ja")), "meeting-decisions");
  assert.equal(pickName("週次まとめを書いて", skillsFor("ja")), "weekly-recap");
});

test("a stopword ending in s isn't shortened into a keyword", () => {
  const thisWeek = summary({
    name: "this-week",
    displayName: "This week",
    description: "Lists what is due this week. Use on Mondays.",
  });

  assert.equal(pickName("translate this to French", [thisWeek]), null);
  assert.equal(pickName("what does this mean", [thisWeek]), null);
});
