const BUILTIN_MEETING_TYPES = [
  {
    name: "Standup",
    template: `For each speaker, create a subsection with their name as the heading:
### [Speaker Name]
- **Yesterday/Since last standup:** What they completed or worked on
- **Today/Next:** What they plan to tackle
- **Blockers:** Any impediments (note severity — is this a soft concern or a hard stop?)

After all speakers, add:
### Cross-Cutting Themes
Note any patterns: multiple people blocked on the same thing, overlapping work, or items that need coordination.`,
    keywordRules: ["standup", "stand-up", "daily sync", "daily scrum"],
  },
  {
    name: "1:1",
    template: `One subsection per topic discussed, ordered by importance:
### [Topic Name]
**What was discussed:** Key points, context shared, positions taken. Use both speakers' names.
**Feedback exchanged:** Any feedback given or received — note the tone (constructive, direct, tentative).
**Decisions:** What was agreed, or "None — still exploring."

After topics, add:
### Relationship & Sentiment
Brief note on the dynamic: Was the conversation open and candid, or guarded? Did both parties seem aligned? Any signs of tension, frustration, or enthusiasm worth noting?`,
    keywordRules: ["1:1", "one on one", "1-on-1", "one-on-one"],
  },
  {
    name: "Team Sync",
    template: `For each participant who gave an update:
### [Speaker Name]
- **Updates shared:** What they reported on — progress, highlights, announcements
- **Concerns raised:** Any risks, blockers, or worries they surfaced
- **Help needed:** Anything they asked the team for

After all updates, add:
### Team-Wide Observations
Note cross-team dependencies, recurring themes, morale signals, or anything that suggests alignment (or misalignment) across the group.`,
    keywordRules: ["team sync", "team meeting", "all hands"],
  },
  {
    name: "Project Sync",
    template: `Organize by project area or workstream:
### [Area / Workstream]
- **Status:** On track / At risk / Blocked — with evidence from the discussion
- **Milestones:** What was hit, what was missed, what's next
- **Risks & Blockers:** Specific concerns raised, who raised them, and proposed mitigations
- **Scope or timeline changes:** Any shifts discussed

After all areas, add:
### Overall Project Health
One paragraph assessment: Is this project trending well or showing warning signs? Are commitments realistic given what was discussed?`,
    keywordRules: ["project sync", "project update", "project status"],
  },
  {
    name: "Sprint Planning",
    template: `### Sprint Goals
What the team committed to delivering this sprint — stated goals and themes.

### Stories & Tasks Discussed
For each story/task discussed:
- **[Story/Task]:** Brief description, estimate (if agreed), assignee (if stated), any concerns raised

### Carryover from Previous Sprint
Items brought forward — note why they weren't completed and whether scope was adjusted.

### Capacity & Risks
Capacity concerns raised, PTO mentions, dependencies on other teams, and anything that could derail the sprint.`,
    keywordRules: ["sprint planning", "sprint plan", "backlog grooming", "refinement"],
  },
  {
    name: "Architecture Review",
    template: `### Proposals Reviewed
For each architectural proposal or design discussed:
- **Proposal:** What was presented and by whom
- **Decision:** Approved / Rejected / Needs revision — with the reasoning
- **Alternatives considered:** What else was evaluated and why it was ruled out
- **Trade-offs acknowledged:** What the team is accepting by choosing this approach

### Risks & Concerns
Technical risks identified, scalability concerns, security considerations, or maintenance burden discussed.

### Open Questions
Items that need more investigation, prototyping, or input from someone not in the room.`,
    keywordRules: ["architecture review", "design review", "tech review", "arch review"],
  },
  {
    name: "Customer Call",
    template: `### Customer Context
Who the customer is (if mentioned), their role, and what prompted this call.

### Customer Needs & Pain Points
- What problems or frustrations the customer described — in their words where possible
- Severity and urgency as expressed by the customer

### Feature Requests & Wishlist
Specific capabilities or changes the customer asked for, with context on why they need them.

### Commitments Made
Separate clearly:
- **Customer-facing commitments:** What we told the customer we'd do (be precise — these are promises)
- **Internal follow-ups:** What we need to do internally that wasn't communicated to the customer

### Customer Sentiment
How did the customer seem? Satisfied, frustrated, neutral, enthusiastic? Did the call end on a positive or negative note? Any churn risk signals?`,
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
