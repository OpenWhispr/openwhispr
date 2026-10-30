import { eq } from 'drizzle-orm';
import type { GoogleCalendarEvent } from '@/data';
import { notes } from '@/db/schema';
import { createMemoryRepository } from '@/data/local/__tests__/testDb';
import { buildChatSuggestions } from '../chatSuggestions';
import { runChatTurn, type ChatTurnDeps } from '../runChatTurn';
import type { ChatMessage } from '../types';

// Every chip on the Chat root must reach notes through the real search, even when none of its
// words appear in them, and never reach notes it isn't about.

// Thursday, October 22. Built with local-time constructors so the periods don't depend on the
// machine's timezone.
const NOW = new Date(2026, 9, 22, 9, 0, 0);

type Seed = (title: string, content: string, created: Date, noteType?: string) => number;

const setUp = (): { deps: ChatTurnDeps; ids: Record<string, number>; seed: Seed } => {
  const { repo, db } = createMemoryRepository();
  const seed: Seed = (title, content, created, noteType = 'personal') => {
    const { id } = repo.createNote(title, content);
    const createdAt = created.toISOString();
    db.update(notes)
      .set({ noteType, createdAt, updatedAt: createdAt })
      .where(eq(notes.id, id))
      .run();
    return id;
  };

  const ids = {
    // This week's meeting says nothing a chip asks about in so many words.
    contractCall: seed(
      'Contract call',
      'Dana sends the contract by Friday.',
      new Date(2026, 9, 21, 15, 0),
      'meeting',
    ),
    groceries: seed('Groceries', 'Oat milk, coffee.', new Date(2026, 9, 20, 18, 0)),
    acmeKickoff: seed(
      'Acme sync',
      'Kickoff: renewal is due in March.',
      new Date(2026, 8, 10, 10, 0),
      'meeting',
    ),
    oldDecision: seed('Paint', 'We decided on blue.', new Date(2026, 8, 1, 12, 0)),
    oldSeats: seed('Seats', 'Ship 15 seats.', new Date(2026, 8, 2, 12, 0)),
    budget: seed('Budget', 'Prepare the budget.', new Date(2026, 8, 3, 12, 0)),
  };

  const deps: ChatTurnDeps = {
    getCandidateNotes: (terms, options) => repo.getChatCandidateNotes(terms, options),
    getNote: (noteId) => repo.getNoteById(noteId),
    isNotePrivate: () => false,
    getNoteTranscript: () => '',
    getConnectedCalendarAccounts: () => [],
    getCalendarEvents: () => [],
    chat: jest.fn(async () => ({ text: 'The answer.', model: 'test' })),
    getChatSelection: () => ({ mode: 'openwhispr' }),
  };
  return { deps, ids, seed };
};

const sourcesFor = async (
  question: string,
  deps: ChatTurnDeps,
  history: ChatMessage[] = [],
): Promise<number[]> => {
  const result = await runChatTurn(
    {
      question,
      history,
      signal: new AbortController().signal,
      allowCloudFallback: false,
      onSteps: () => undefined,
      now: NOW,
    },
    deps,
  );
  return result.sources.map((source) => source.noteId);
};

const ACME_SYNC = {
  id: 1,
  summary: 'Acme sync',
  startAt: new Date(2026, 9, 22, 15, 15).toISOString(),
  endAt: new Date(2026, 9, 22, 15, 45).toISOString(),
  allDay: 0,
  attendeesJson: JSON.stringify([
    { email: 'me@example.com', self: true },
    { email: 'dana@acme.com', responseStatus: 'accepted' },
  ]),
} as GoogleCalendarEvent;

const chip = (label: string, events: GoogleCalendarEvent[] = [ACME_SYNC]): string => {
  const suggestion = buildChatSuggestions({ events, now: NOW }).find(
    (candidate) => candidate.label === label,
  );
  if (!suggestion) throw new Error(`No chip labelled ${label}`);
  return suggestion.prompt;
};

describe('Chat root chips', () => {
  it('includes twenty recent meeting summaries through the real SQLite search', async () => {
    const { deps, ids, seed } = setUp();
    const recent = Array.from({ length: 22 }, (_, index) =>
      seed(
        `Weekly meeting ${index + 1}`,
        `Decision ${index + 1}: ship the agreed work.`,
        new Date(2026, 9, 22, 8, index),
        'meeting',
      ),
    );
    const result = await sourcesFor('Summarize my meetings this week', deps);
    expect(result).toEqual(recent.slice(2).reverse());
    expect(result).not.toContain(ids.groceries);
    expect(result).not.toContain(ids.acmeKickoff);
    expect(result).not.toContain(ids.contractCall);
    const request = jest.mocked(deps.chat).mock.calls[0][0];
    expect(request.text).toContain('20 of 23 meetings from this week');
  });

  it('summarizes only this week’s meetings', async () => {
    const { deps, ids } = setUp();
    expect(await sourcesFor(chip('Summarize my meetings this week'), deps)).toEqual([
      ids.contractCall,
    ]);
  });

  it.each([
    'What are my open action items from this week?',
    'Who have I promised to follow up with lately?',
  ])('reads this week’s notes for “%s”', async (label) => {
    const { deps, ids } = setUp();
    expect(await sourcesFor(chip(label), deps)).toEqual([ids.contractCall, ids.groceries]);
  });

  it('reads the last 7 days’ notes, not an older decision', async () => {
    const { deps, ids } = setUp();
    expect(await sourcesFor(chip('What did I decide recently?'), deps)).toEqual([
      ids.contractCall,
      ids.groceries,
    ]);
  });

  it('preps for a meeting from the notes about it alone', async () => {
    const { deps, ids } = setUp();
    expect(await sourcesFor(chip('Prep me for Acme sync'), deps)).toEqual([ids.acmeKickoff]);
  });

  it('preps for a meeting whose title holds a time word from the notes about it', async () => {
    const { deps, seed } = setUp();
    const priorities = seed('Priorities', 'Hiring first.', new Date(2026, 8, 15, 9, 0));
    const event = { ...ACME_SYNC, summary: 'Today’s priorities' };

    expect(await sourcesFor(chip('Prep me for Today’s priorities', [event]), deps)).toEqual([
      priorities,
    ]);
  });

  it('sends no notes for a question none of them answer', async () => {
    const { deps } = setUp();
    expect(await sourcesFor('What is the capital of France?', deps)).toEqual([]);
  });
});

describe('Chat questions through the real search', () => {
  it('finds an older note when nothing recent matches', async () => {
    const { deps, seed } = setUp();
    const pricing = seed('Pricing', 'Pricing decision: $20 a seat.', new Date(2026, 8, 5, 12, 0));

    expect(await sourcesFor('What was our most recent pricing decision?', deps)).toEqual([pricing]);
  });

  it('sends this week’s notes that match a topic first, then the rest of the week', async () => {
    const { deps, ids, seed } = setUp();
    const planning = seed('Q4 planning', 'The budget is 40k.', new Date(2026, 9, 19, 11, 0));

    expect(await sourcesFor('What is the budget this week?', deps)).toEqual([
      planning,
      ids.contractCall,
      ids.groceries,
    ]);
    expect((deps.chat as jest.Mock).mock.calls[0][0].text).toContain(
      'NOTES (3 of 3 notes from this week, matching ones first):',
    );
  });

  it('counts no empty match, so a “recent” question still finds the older note', async () => {
    const { deps, seed } = setUp();
    seed('Pricing', '', new Date(2026, 9, 21, 16, 0));
    const pricing = seed('Pricing', 'Pricing decision: $20 a seat.', new Date(2026, 8, 5, 12, 0));

    expect(await sourcesFor('What was our most recent pricing decision?', deps)).toEqual([pricing]);
  });

  it('sends this week’s notes when none of them match a topic', async () => {
    const { deps, ids } = setUp();
    expect(await sourcesFor('What is the budget this week?', deps)).toEqual([
      ids.contractCall,
      ids.groceries,
    ]);
  });

  describe('asking what went on in a period', () => {
    // Today's notes, the older one saying a word the question asks with.
    const seedToday = (seed: Seed): { incident: number; standup: number } => ({
      incident: seed('Renewal call', 'The outage happened at 2am.', new Date(2026, 9, 22, 7, 0)),
      standup: seed('Standup', 'Shipped the export.', new Date(2026, 9, 22, 8, 30)),
    });

    it.each(['What happened today?', 'Anything new today?'])(
      'reads all of today’s notes, newest first, for “%s”',
      async (question) => {
        const { deps, seed } = setUp();
        const today = seedToday(seed);

        expect(await sourcesFor(question, deps)).toEqual([today.standup, today.incident]);
      },
    );

    it('reads the last 7 days, not an older note saying “happened”', async () => {
      const { deps, ids, seed } = setUp();
      seed('Offsite', 'Nothing much happened.', new Date(2026, 7, 14, 12, 0));

      expect(await sourcesFor('What happened recently?', deps)).toEqual([
        ids.contractCall,
        ids.groceries,
      ]);
    });

    it('reads the last 7 days when no note says the question’s words', async () => {
      const { deps, ids, seed } = setUp();
      // "work" inside "network" must not pull an old note past the period.
      seed('Old network', 'Network migration work plan.', new Date(2026, 6, 10, 9, 0));
      expect(await sourcesFor('What did I work on lately?', deps)).toEqual([
        ids.contractCall,
        ids.groceries,
      ]);
    });

    it('reads this week’s to-dos with the action items chip, the matching one first', async () => {
      const { deps, ids, seed } = setUp();
      const actionItems = seed(
        'Design review',
        'Action items: Sam updates the mocks.',
        new Date(2026, 9, 19, 10, 0),
        'meeting',
      );
      const flights = seed('Trip', '- [ ] Book flights', new Date(2026, 9, 22, 8, 0));

      expect(await sourcesFor(chip('What are my open action items from this week?'), deps)).toEqual(
        [actionItems, flights, ids.contractCall, ids.groceries],
      );
    });
  });

  describe('a broad question', () => {
    const CLARIFY = 'reply with one short question asking which topic or time period they mean';
    const sentText = (deps: ChatTurnDeps): string => (deps.chat as jest.Mock).mock.calls[0][0].text;
    const message = (id: string, role: ChatMessage['role'], text: string): ChatMessage => ({
      id,
      conversationId: 'c1',
      role,
      text,
      steps: [],
      sources: [],
      createdAt: 0,
    });
    const CLARIFIED: ChatMessage[] = [
      message('m1', 'user', 'What did we decide?'),
      message('m2', 'assistant', 'Which meeting or time period do you mean — like this week?'),
    ];

    it.each(['What did we decide?', 'What’s on my plate?'])(
      'sends no notes and asks the model to clarify “%s”',
      async (question) => {
        const { deps } = setUp();
        expect(await sourcesFor(question, deps)).toEqual([]);
        expect(sentText(deps)).toContain(CLARIFY);
      },
    );

    it('reads this week’s notes when the answer names the period', async () => {
      const { deps, ids } = setUp();
      expect(await sourcesFor('This week', deps, CLARIFIED)).toEqual([
        ids.contractCall,
        ids.groceries,
      ]);
      expect(sentText(deps)).toContain('User: What did we decide?');
      expect(sentText(deps)).not.toContain(CLARIFY);
    });

    it('finds the meeting the answer names', async () => {
      const { deps, seed } = setUp();
      const falcon = seed('Falcon kickoff', 'We chose Postgres.', new Date(2026, 8, 8, 10, 0));
      expect(await sourcesFor('The Falcon meeting', deps, CLARIFIED)).toEqual([falcon]);
      expect(sentText(deps)).toContain('User: What did we decide?');
    });
  });

  describe('a follow-up or a schedule question', () => {
    // Notes that say the words such questions are asked with, inside other words too.
    const seedChatter = (seed: Seed): void => {
      seed('Groceries list', 'Buy more oat milk.', new Date(2026, 8, 1, 9, 0));
      seed('Journal', 'Furthermore, it rained.', new Date(2026, 8, 2, 9, 0));
      seed(
        'Standup',
        'Thanks all. Sam said time is tight; next meeting tomorrow, last call on the calendar. Can someone explain again? Free after 3.',
        new Date(2026, 8, 3, 9, 0),
        'meeting',
      );
    };

    it.each([
      'Tell me more',
      'When is my next meeting?',
      'Thanks!',
      'Can you explain that again?',
      'Who said that?',
      'What time is it?',
      'What do I have tomorrow?',
      'What is on my calendar?',
      'Summarize the last meeting',
      'Am I free after 3?',
    ])('sends no notes for “%s”', async (question) => {
      const { deps, seed } = setUp();
      seedChatter(seed);
      expect(await sourcesFor(question, deps)).toEqual([]);
    });

    it.each<[string, keyof ReturnType<typeof setUp>['ids']]>([
      ['What did Dana say about the contract?', 'contractCall'],
      ['When is the Acme renewal due?', 'acmeKickoff'],
      ['What did we decide about the paint?', 'oldDecision'],
    ])('still finds the note “%s” is about', async (question, note) => {
      const { deps, ids, seed } = setUp();
      seedChatter(seed);
      expect(await sourcesFor(question, deps)).toEqual([ids[note]]);
    });
  });

  it('sends the lines of a meeting found through what was said in it', async () => {
    const { repo, db } = createMemoryRepository();
    const { id } = repo.createNote('Platform sync', '');
    db.update(notes)
      .set({ noteType: 'meeting', enhancedContent: 'We reviewed the quarter.' })
      .where(eq(notes.id, id))
      .run();
    repo.replaceSegments(id, [
      { noteId: id, startMs: 0, endMs: 1000, text: 'Lunch is at noon.' },
      { noteId: id, startMs: 1000, endMs: 2000, text: 'The SSO bug is fixed in staging.' },
    ]);
    const chat = jest.fn(async () => ({ text: 'The answer.', model: 'test' }));
    const deps: ChatTurnDeps = {
      getCandidateNotes: (terms, options) => repo.getChatCandidateNotes(terms, options),
      getNote: (noteId) => repo.getNoteById(noteId),
      isNotePrivate: () => false,
      getNoteTranscript: (noteId) =>
        repo
          .getSegments(noteId)
          .map((segment) => segment.text)
          .join('\n'),
      getConnectedCalendarAccounts: () => [],
      getCalendarEvents: () => [],
      chat,
      getChatSelection: () => ({ mode: 'openwhispr' }),
    };

    expect(await sourcesFor('Is the SSO bug fixed?', deps)).toEqual([id]);
    const text = (chat as jest.Mock).mock.calls[0][0].text;
    expect(text).toContain(
      'Transcript passages matching the question:\nThe SSO bug is fixed in staging.\n\nGenerated notes:\nWe reviewed the quarter.',
    );
    expect(text).not.toContain('Lunch is at noon.');
  });

  it.each([
    // Only the number can find these notes.
    ['What ships in 1.10?', 'Release', 'Version 1.10 adds export.'],
    ['Who owes the $10,000?', 'Invoice', 'Dana pays $10,000.'],
  ])('finds a number written with punctuation for “%s”', async (question, title, content) => {
    const { deps, seed } = setUp();
    const id = seed(title, content, new Date(2026, 8, 20, 12, 0));
    seed('Other', 'Ten went 1.100 and 10,000,000.', new Date(2026, 8, 21, 12, 0));

    expect(await sourcesFor(question, deps)).toEqual([id]);
  });
});
