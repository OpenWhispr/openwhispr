const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/config/prompts.ts");

const RULE_START = "Skills are instructions the user saved for tasks they repeat.";
const CATALOG_INTRO =
  "The user's skills (name: when to use it). Check this list before you answer and before " +
  "you ask the user a follow-up question: when a request fits a skill, call load_skill with " +
  "its name first, then follow it, since the skill may say how to settle what the request " +
  "leaves open. Load only the skills the request needs.";
const CATALOG = "- meeting-prep: Briefs me before meetings.\n- weekly-recap: Recaps my week.";

test("the skill rule and catalog appear only with skills", async () => {
  const { getAgentSystemPrompt } = await load();

  const prompt = getAgentSystemPrompt(["load_skill", "search_notes"], undefined, {
    skillCatalog: CATALOG,
  });

  assert.ok(prompt.includes(`\n\n${CATALOG_INTRO}\n${CATALOG}\n\n`));
  assert.ok(prompt.includes(RULE_START));
  assert.match(prompt, /it never authorizes sending, posting, deleting, buying/);
  assert.match(prompt, /^- The user's skills: load_skill$/m);
  assert.ok(prompt.indexOf(RULE_START) < prompt.indexOf(CATALOG_INTRO));
});

test("a fitting skill is loaded before any follow-up question", async () => {
  const { getAgentSystemPrompt } = await load();

  const prompt = getAgentSystemPrompt(["load_skill"], undefined, { skillCatalog: CATALOG });

  assert.match(prompt, /before you ask the user a follow-up question/);
  assert.match(prompt, /call load_skill with its name first/);
});

test("the rule appears for an attached skill without a catalog", async () => {
  const { getAgentSystemPrompt } = await load();

  const prompt = getAgentSystemPrompt([], undefined, { skillContent: true });

  assert.ok(prompt.includes(RULE_START));
  assert.ok(!prompt.includes("call load_skill"));
});

test("no skills, no change", async () => {
  const { getAgentSystemPrompt } = await load();
  const options = { toolTrace: true, userName: "Sam" };

  const today = getAgentSystemPrompt(["search_notes"], "Note: kickoff", options);

  assert.equal(
    getAgentSystemPrompt(["search_notes"], "Note: kickoff", {
      ...options,
      skillCatalog: "",
      skillContent: false,
    }),
    today
  );
  assert.doesNotMatch(today, /skill/i);
});
