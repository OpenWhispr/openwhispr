const BUILTIN_MEETING_TYPES = [
  {
    name: "Standup",
    template: `For each speaker, summarize:
- What they worked on since the last standup
- What they plan to work on next
- Any blockers or issues raised

End with a consolidated Action Items section with checkboxes.`,
    keywordRules: ["standup", "stand-up", "daily sync", "daily scrum"],
  },
  {
    name: "1:1",
    template: `Summarize the discussion topics covered. For each topic, note:
- Key points discussed
- Feedback given or received
- Decisions made

End with an Action Items section with checkboxes, attributing each item to the relevant person.`,
    keywordRules: ["1:1", "one on one", "1-on-1", "one-on-one"],
  },
  {
    name: "Team Sync",
    template: `Summarize each participant's update:
- Personal highlights or updates they shared
- Announcements made
- What they worked on (past week) and what's coming up

End with an Action Items section with checkboxes.`,
    keywordRules: ["team sync", "team meeting", "all hands"],
  },
  {
    name: "Project Sync",
    template: `Summarize the project status updates discussed:
- Milestones hit or missed
- Risks and blockers raised
- Decisions made
- Timeline or scope changes

End with an Action Items section with checkboxes.`,
    keywordRules: ["project sync", "project update", "project status"],
  },
  {
    name: "Sprint Planning",
    template: `Summarize the sprint planning discussion:
- Stories or tasks discussed (with any estimates agreed)
- Sprint goals defined
- Carryover items from previous sprint
- Capacity concerns raised

End with an Action Items section with checkboxes.`,
    keywordRules: ["sprint planning", "sprint plan", "backlog grooming", "refinement"],
  },
  {
    name: "Architecture Review",
    template: `Summarize the architecture discussion:
- Decisions made (and the reasoning behind each)
- Alternatives considered and why they were rejected
- Risks or concerns identified
- Open questions requiring follow-up

End with an Action Items section with checkboxes.`,
    keywordRules: ["architecture review", "design review", "tech review", "arch review"],
  },
  {
    name: "Customer Call",
    template: `Summarize the customer interaction:
- Customer pain points or issues raised
- Feature requests mentioned
- Commitments or promises made
- Follow-up questions or next steps agreed

End with an Action Items section with checkboxes, clearly separating internal follow-ups from customer-facing commitments.`,
    keywordRules: ["customer call", "client call", "customer meeting", "client meeting", "sales call"],
  },
];

function seedMeetingTypes(db) {
  const existing = db.prepare("SELECT COUNT(*) as c FROM meeting_types WHERE is_builtin = 1").get();
  if (existing.c > 0) return;

  const insert = db.prepare(
    "INSERT INTO meeting_types (name, template, is_builtin, keyword_rules) VALUES (?, ?, 1, ?)"
  );
  const transaction = db.transaction(() => {
    for (const type of BUILTIN_MEETING_TYPES) {
      insert.run(type.name, type.template, JSON.stringify(type.keywordRules || []));
    }
  });
  transaction();
}

module.exports = { seedMeetingTypes, BUILTIN_MEETING_TYPES };
