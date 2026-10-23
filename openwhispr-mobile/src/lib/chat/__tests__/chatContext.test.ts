import type { GoogleCalendarEvent, Note } from '@/data';
import {
  buildChatPayload,
  CHAT_NOTE_CHAR_CAP,
  CHAT_SYSTEM_PROMPT,
  extractSearchTerms,
  parseChatQuery,
} from '../chatContext';
import type { ChatMessage } from '../types';

// Built with local-time constructors so assertions don't depend on the machine's timezone.
const NOW = new Date(2026, 9, 22, 9, 0, 0);

const formatTime = (date: Date): string =>
  date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

const makeNote = (overrides: Partial<Note> & { id: number }): Note =>
  ({
    title: 'Untitled',
    content: '',
    enhancedContent: null,
    updatedAt: new Date(2026, 9, 20, 12, 0, 0).toISOString(),
    ...overrides,
  }) as Note;

const makeEvent = (summary: string | null, start: Date, end: Date): GoogleCalendarEvent =>
  ({
    id: 1,
    summary,
    startAt: start.toISOString(),
    endAt: end.toISOString(),
  }) as GoogleCalendarEvent;

const makeMessage = (index: number): ChatMessage => ({
  id: `m${index}`,
  conversationId: 'c1',
  role: index % 2 === 0 ? 'user' : 'assistant',
  text: `message ${index}`,
  steps: [],
  sources: [],
  createdAt: index,
});

const buildPayload = (overrides: Partial<Parameters<typeof buildChatPayload>[0]> = {}) =>
  buildChatPayload({
    question: 'What happened?',
    history: [],
    notes: [],
    calendar: [],
    now: NOW,
    ...overrides,
  });

describe('parseChatQuery', () => {
  // NOW is Thursday, October 22.
  const day = (date: number): Date => new Date(2026, 9, date);

  it('reads each period from local midnight, weeks from Monday', () => {
    const cases: [string, Date, Date, string, boolean][] = [
      ['What happened today?', day(22), day(23), 'today', false],
      ['What did I say yesterday?', day(21), day(22), 'yesterday', false],
      ['What happened this week?', day(19), day(23), 'this week', false],
      ['What happened last  week?', day(12), day(19), 'last week', false],
      ['Anything recent?', day(16), day(23), 'the last 7 days', true],
      ['What did I decide Recently?', day(16), day(23), 'the last 7 days', true],
      ['Who did I meet lately?', day(16), day(23), 'the last 7 days', true],
    ];
    for (const [question, start, end, label, soft] of cases) {
      expect(parseChatQuery(question, NOW).scope).toEqual({
        start,
        end,
        meetingsOnly: false,
        label,
        soft,
      });
    }
  });

  it('starts a week on Monday even on a Sunday', () => {
    expect(parseChatQuery('this week', new Date(2026, 9, 25, 20, 0)).scope?.start).toEqual(day(19));
  });

  it('keeps the period’s words out of the search, and "meetings" when it narrows to them', () => {
    expect(parseChatQuery('Summarize my meetings this week', NOW)).toEqual({
      terms: [],
      scope: expect.objectContaining({ meetingsOnly: true, label: 'this week' }),
    });
    expect(parseChatQuery('What did we decide on pricing today?', NOW).terms).toEqual(['pricing']);
  });

  it('names no period, and keeps every word, when the question names none', () => {
    expect(parseChatQuery('What did the meeting say about the weekly budget?', NOW)).toEqual({
      terms: ['meeting', 'say', 'weekly', 'budget'],
      scope: null,
    });
  });

  it('reads no period from a quoted meeting title, and still searches its words', () => {
    expect(parseChatQuery('Prep me for "Today\'s priorities" at 9:00 AM.', NOW)).toEqual({
      terms: ['today', 'priorities'],
      scope: null,
    });
    expect(parseChatQuery('Notes on “Last week recap” from this week', NOW)).toEqual({
      terms: ['last', 'week', 'recap'],
      scope: expect.objectContaining({ label: 'this week' }),
    });
  });

  it('keeps the topic words of a question that names a period', () => {
    expect(parseChatQuery('What was our most recent pricing decision?', NOW)).toEqual({
      terms: ['pricing', 'decision'],
      scope: expect.objectContaining({ soft: true }),
    });
  });

  it('leaves the chips no asking words to search for', () => {
    expect(parseChatQuery('What are my open action items from this week?', NOW).terms).toEqual([
      'action',
      'items',
    ]);
    expect(parseChatQuery('Who have I promised to follow up with lately?', NOW).terms).toEqual([]);
    expect(parseChatQuery('What did I decide recently?', NOW).terms).toEqual([]);
    expect(extractSearchTerms('Summarise what we decided')).toEqual([]);
  });

  it('leaves no asking words in a question about what went on in a period', () => {
    expect(parseChatQuery('What happened today?', NOW).terms).toEqual([]);
    expect(parseChatQuery('Anything new today?', NOW).terms).toEqual([]);
    expect(parseChatQuery('What has been happening lately?', NOW).terms).toEqual([]);
    expect(extractSearchTerms('What happens next with the merger?')).toEqual(['next', 'merger']);
    expect(extractSearchTerms('How is the new hire going?')).toEqual(['hire']);
  });

  it('leaves no topic in a broad question about what the user did or has on', () => {
    for (const question of ['What did we decide?', 'What’s on my plate?', 'What did I work on?']) {
      expect(parseChatQuery(question, NOW)).toEqual({ terms: [], scope: null });
    }
    expect(parseChatQuery('What is on our plate this week?', NOW)).toEqual({
      terms: [],
      scope: expect.objectContaining({ label: 'this week' }),
    });
    expect(parseChatQuery('How is work on Falcon going?', NOW).terms).toEqual(['falcon']);
    expect(parseChatQuery('Prep me for "Work on my plate"', NOW).terms).toEqual(['work', 'plate']);
  });
});

describe('extractSearchTerms', () => {
  it('drops stopwords and short words', () => {
    expect(extractSearchTerms('What did Priya say about the onboarding flow?')).toEqual([
      'priya',
      'say',
      'onboarding',
      'flow',
    ]);
  });

  it('de-duplicates and keeps at most six terms', () => {
    expect(extractSearchTerms('alpha alpha beta gamma delta epsilon zeta eta theta')).toEqual([
      'alpha',
      'beta',
      'gamma',
      'delta',
      'epsilon',
      'zeta',
    ]);
  });

  it('never returns a blank term', () => {
    expect(extractSearchTerms('  ?? ! a to ')).toEqual([]);
  });

  it('drops question words and auxiliaries', () => {
    expect(extractSearchTerms('When was the Acme kickoff, and how have we done?')).toEqual([
      'acme',
      'kickoff',
    ]);
  });

  it('keeps two-character terms', () => {
    expect(extractSearchTerms('What is our Q3 AI budget?')).toEqual(['q3', 'ai', 'budget']);
  });

  it('drops two-character words that are neither codes nor capitalised', () => {
    expect(extractSearchTerms('Did he go over the ai email? Hi, OK')).toEqual(['over', 'email']);
    expect(extractSearchTerms('Ask HR about 2x pay')).toEqual(['ask', 'hr', '2x', 'pay']);
  });

  it('keeps two-syllable Korean words', () => {
    expect(extractSearchTerms('회의 예산 어때?')).toEqual(['회의', '예산', '어때']);
  });

  it('drops two-letter Arabic and Hebrew particles', () => {
    expect(extractSearchTerms('ما هي قرارات الميزانية في اجتماع الأمس؟')).toEqual([
      'قرارات',
      'الميزانية',
      'اجتماع',
      'الأمس',
    ]);
    expect(extractSearchTerms('מה זה של התקציב')).toEqual(['התקציב']);
  });

  it('keeps a number joined by "." "," or ":" as one term', () => {
    expect(extractSearchTerms('What ships in 1.10?')).toEqual(['ships', '1.10']);
    expect(extractSearchTerms('Who owes the $10,000?')).toEqual(['owes', '10,000']);
    expect(extractSearchTerms('Is 10. enough, or 10.5:1?')).toEqual(['10', 'enough', '10.5:1']);
    expect(extractSearchTerms('Who pays 1,250,000?')).toEqual(['pays', '1,250,000']);
  });

  it('joins numbers at a comma only before a thousands group', () => {
    expect(extractSearchTerms('Pick 13,4 and 25')).toEqual(['pick', '13', '25']);
    expect(extractSearchTerms('Budget for 2025,2026')).toEqual(['budget', '2025', '2026']);
    expect(extractSearchTerms('Rows 10,0000')).toEqual(['rows', '10', '0000']);
  });

  it('drops a clock time and the "prep" of a meeting prep', () => {
    expect(extractSearchTerms('Prep me for "Acme sync" at 3:15 PM.')).toEqual(['acme', 'sync']);
    expect(extractSearchTerms('Standup at 10:30am about Q3')).toEqual(['standup', 'q3']);
  });

  it('splits Chinese and Japanese runs into bigrams', () => {
    expect(extractSearchTerms('预算会议')).toEqual(['预算', '算会', '会议']);
    expect(extractSearchTerms('Acme 会議')).toEqual(['acme', '会議']);
    expect(extractSearchTerms('第三季度预算会议的结论是什么')).toHaveLength(6);
  });
});

describe('buildChatPayload', () => {
  it('uses the assistant system prompt', () => {
    expect(buildPayload().systemPrompt).toBe(CHAT_SYSTEM_PROMPT);
    // A follow-up must not repeat the notes an earlier answer cited.
    expect(CHAT_SYSTEM_PROMPT).toContain(
      "Name by title only notes listed under NOTES. A follow-up can still be answered from RECENT CHAT, but don't name or cite the notes an earlier answer named.",
    );
  });

  it('fills notes until the budget and lists only the included notes as sources', () => {
    const notes = [1, 2, 3].map((id) =>
      makeNote({ id, title: `Note ${id}`, content: 'x'.repeat(7_000) }),
    );

    const { text, sources } = buildPayload({ notes, noteCharBudget: 13_000 });

    expect(text.match(/^### /gm)).toHaveLength(2);
    expect(text).not.toContain('x'.repeat(CHAT_NOTE_CHAR_CAP + 1));
    expect(sources).toEqual([
      { noteId: 1, title: 'Note 1' },
      { noteId: 2, title: 'Note 2' },
    ]);
  });

  it('cuts the first note to the budget instead of dropping it', () => {
    const notes = [
      makeNote({ id: 1, title: 'Long', content: 'a'.repeat(4_000) }),
      makeNote({ id: 2, title: 'Also long', content: 'b'.repeat(4_000) }),
    ];

    const { text, sources } = buildPayload({ notes, noteCharBudget: 3_000 });

    expect(sources).toEqual([{ noteId: 1, title: 'Long' }]);
    expect(text.match(/^### /gm)).toHaveLength(1);
    expect(text).toContain('[...rest of the note omitted...]');
    expect(
      text.match(/a+/g)?.reduce((longest, run) => Math.max(longest, run.length), 0),
    ).toBeLessThanOrEqual(3_000);
    expect(text).not.toContain('b'.repeat(10));
  });

  it('fits a smaller later note after skipping one that is too long', () => {
    const notes = [
      makeNote({ id: 1, title: 'First', content: 'a'.repeat(5_000) }),
      makeNote({ id: 2, title: 'Too long', content: 'b'.repeat(5_000) }),
      makeNote({ id: 3, title: 'Small', content: 'c'.repeat(500) }),
    ];

    const { sources } = buildPayload({ notes, noteCharBudget: 6_000 });

    expect(sources.map((source) => source.noteId)).toEqual([1, 3]);
  });

  it('puts the AI summary first, so a long note loses the end of its own text', () => {
    const notes = [
      makeNote({
        id: 1,
        title: 'Planning',
        content: `TYPED ${'a'.repeat(CHAT_NOTE_CHAR_CAP)} TYPED_END`,
        enhancedContent: 'SUMMARY: we ship Friday.',
      }),
    ];

    const { text } = buildPayload({ notes });

    expect(text).toContain('Generated notes:\nSUMMARY: we ship Friday.\n\nNote content:\nTYPED');
    expect(text).not.toContain('TYPED_END');
  });

  it('sends the transcript of a note with no text or summary', () => {
    const notes = [
      makeNote({ id: 1, title: 'Weekly sync' }),
      makeNote({ id: 2, title: 'Summarized', enhancedContent: 'The summary' }),
    ];
    const transcripts = new Map([
      [1, 'Meeting transcript:\n[00:00] Priya: We ship Friday.'],
      [2, 'Meeting transcript:\n[00:00] Sam: Not sent.'],
    ]);

    const { text } = buildPayload({ notes, transcripts });

    expect(text).toContain('### Weekly sync');
    expect(text).toContain('[00:00] Priya: We ship Friday.');
    expect(text).toContain('The summary');
    expect(text).not.toContain('Not sent.');
  });

  it('cuts a long transcript to its start and its end', () => {
    const transcript = `START ${'a'.repeat(CHAT_NOTE_CHAR_CAP)} END`;
    const notes = [makeNote({ id: 1, title: 'Weekly sync' })];

    const { text } = buildPayload({ notes, transcripts: new Map([[1, transcript]]) });

    expect(text).toContain('START');
    expect(text).toContain('END');
    expect(text).toContain('[...middle omitted for chat context...]');
  });

  it('skips a note with nothing to read', () => {
    const notes = [
      makeNote({ id: 1, title: 'Failed recording' }),
      makeNote({ id: 2, title: 'Pricing', content: 'We kept $12.' }),
    ];

    const { text, sources } = buildPayload({ notes });

    expect(text).not.toContain('Failed recording');
    expect(sources).toEqual([{ noteId: 2, title: 'Pricing' }]);
  });

  it('says how many of a period’s notes it sends, each with the day it was made', () => {
    const scope = parseChatQuery('Summarize my meetings this week', NOW).scope;
    if (!scope) throw new Error('No period');
    const notes = [21, 20].map((date) =>
      makeNote({
        id: date,
        title: `Sync ${date}`,
        content: 'Body',
        createdAt: new Date(2026, 9, date, 10, 0).toISOString(),
        updatedAt: NOW.toISOString(),
      }),
    );

    const { text } = buildPayload({ notes, period: { scope, total: 9, matched: false } });
    expect(text).toContain('NOTES (2 of 9 meetings from this week, newest first):\n### Sync 21');
    expect(text).toMatch(/### Sync 21 \(created Oct 21\)\nBody/);
    expect(text).toMatch(/### Sync 20 \(created Oct 20\)\nBody/);

    const matched = buildPayload({ notes, period: { scope, total: 3, matched: true } }).text;
    expect(matched).toContain('NOTES (2 of 3 meetings from this week, matching ones first):');
  });

  it('words the heading for a single note from a period', () => {
    const scope = parseChatQuery('Summarize my meetings this week', NOW).scope;
    if (!scope) throw new Error('No period');
    const notes = [makeNote({ id: 1, title: 'Sync', content: 'Body' })];

    const matched = buildPayload({ notes, period: { scope, total: 1, matched: true } }).text;
    expect(matched).toContain('NOTES (1 of 1 meeting from this week, matching the question):');
    const newest = buildPayload({ notes, period: { scope, total: 1, matched: false } }).text;
    expect(newest).toContain('NOTES (1 of 1 meeting from this week, newest first):');
  });

  describe('earlier answers in the recent chat', () => {
    const historyText = (answer: string): string =>
      buildPayload({ history: [makeMessage(0), { ...makeMessage(1), text: answer }] }).text;

    it.each([
      'Cut the budget by 15%.\n\n**Source:** Untitled\nNotes used: Pricing sync',
      'Cut the budget by 15%.\n\n### Sources\n- Untitled\n- Pricing sync',
      'Cut the budget by 15%.\n\n**Sources:**\n1. Untitled\n2. Pricing sync',
      'Cut the budget by 15%.\nSource(s): Untitled, Pricing sync',
      'Cut the budget by 15%.\n\nSources:\n\n- Untitled\n\n- Pricing sync',
    ])('leave out a closing source block: %j', (answer) => {
      const text = historyText(answer);
      expect(text).toContain('Assistant: Cut the budget by 15%.');
      expect(text).not.toContain('Untitled');
      expect(text).not.toContain('Pricing sync');
    });

    it.each([
      'Sources of revenue: ads and subscriptions.',
      'Source code: see the repo.\n\nNotes: none.',
      '- Sources: CRM and Stripe exports\n- Owner: Dana',
      '```yaml\n- source: ./data\n```',
      '**Source:** the CFO forecast in Pricing sync',
      'Pipeline:\n- Sources: CRM and Stripe exports\n- Owner: Dana',
      'Article:\n- Title: X\n- Source: Reuters\n- Date: Oct 1',
      'Here is what was decided.\n\n**Source:** Pricing sync\n- Cut the budget 15%\n- Launch moved to May',
    ])('keep text that only mentions a source: %j', (answer) => {
      expect(historyText(answer)).toContain(answer);
    });

    it('keeps a source item in the answer\u2019s own list while dropping the closing source', () => {
      const text = historyText(
        'Key points:\n- Revenue up 8%\n- Sources: CRM and Stripe\n- Margins flat\n\n**Source:** Pricing sync',
      );
      expect(text).toContain('- Sources: CRM and Stripe\n- Margins flat');
      expect(text).not.toContain('Pricing sync');
    });
  });

  it('says when there are no matching notes', () => {
    const { text } = buildPayload({ question: 'What is the capital of France?' });
    expect(text).toContain(
      "NOTES:\nNo matching notes. Don't name or cite any note in this answer, including notes named earlier in RECENT CHAT.\n\nRECENT CHAT:",
    );
  });

  describe('a question naming no topic or period', () => {
    const CLARIFY = 'reply with one short question asking which topic or time period they mean';

    it.each(['What did we decide?', 'What’s on my plate?'])(
      'asks the model to clarify “%s” when no notes are sent',
      (question) => {
        const { text } = buildPayload({ question });
        expect(text).toContain(
          'NOTES:\nNone. The question names no topic or time period, so no notes were included.',
        );
        expect(text).toContain(CLARIFY);
        expect(text).toContain('If it is a general-knowledge question, just answer it.');
      },
    );

    it('lets a follow-up with no topic be answered from the chat so far', () => {
      const { text } = buildPayload({
        question: 'Who decided that?',
        history: [makeMessage(0), makeMessage(1)],
      });
      expect(text).toContain('If the recent chat already shows what they mean, answer from it.');
      // Answered from the chat, the follow-up still cites no note: none were sent with it.
      expect(text).toContain("Don't name or cite any note in this answer");
      expect(text).toContain('message 1');
    });

    it('keeps the usual notes for a topic, a period or notes sent', () => {
      const scope = parseChatQuery('What did we decide this week?', NOW).scope;
      if (!scope) throw new Error('No period');
      const notes = [makeNote({ id: 1, title: 'Plan', content: 'Body' })];
      const payloads = [
        buildPayload({ question: 'What is the capital of France?' }),
        buildPayload({
          question: 'What did we decide this week?',
          period: { scope, total: 0, matched: false },
        }),
        buildPayload({ question: 'What did we decide?', notes }),
      ];
      for (const { text } of payloads) expect(text).not.toContain(CLARIFY);
    });
  });

  it('says when no calendar is connected', () => {
    expect(buildPayload({ calendar: null }).text).toContain('No calendar connected.');
  });

  it('says when the calendar could not be read', () => {
    const { text } = buildPayload({ calendar: 'unavailable' });
    expect(text).toContain('CALENDAR (next 48 hours):\nCalendar unavailable right now.');
    expect(text).not.toContain('No calendar connected.');
  });

  it('says when the next 48 hours are empty', () => {
    expect(buildPayload({ calendar: [] }).text).toContain('No meetings in the next 48 hours.');
  });

  it('lists only meetings in the next 48 hours', () => {
    const calendar = [
      makeEvent('Already over', new Date(2026, 9, 22, 7, 0), new Date(2026, 9, 22, 8, 0)),
      makeEvent('Standup', new Date(2026, 9, 22, 10, 0), new Date(2026, 9, 22, 10, 30)),
      makeEvent(null, new Date(2026, 9, 23, 14, 0), new Date(2026, 9, 23, 15, 0)),
      makeEvent('Next week', new Date(2026, 9, 28, 10, 0), new Date(2026, 9, 28, 11, 0)),
    ];
    const { text } = buildPayload({ calendar });

    expect(text).toContain(
      `- Standup · ${formatTime(new Date(2026, 9, 22, 10, 0))}–${formatTime(new Date(2026, 9, 22, 10, 30))}`,
    );
    expect(text).toContain('- Untitled meeting · ');
    expect(text).not.toContain('Already over');
    expect(text).not.toContain('Next week');
  });

  it("labels tomorrow's meetings", () => {
    const start = new Date(2026, 9, 23, 14, 0);
    const end = new Date(2026, 9, 23, 15, 0);

    const { text } = buildPayload({ calendar: [makeEvent('Review', start, end)] });

    expect(text).toContain(`- Review · Tomorrow ${formatTime(start)}–${formatTime(end)}`);
  });

  it('labels later meetings with the weekday and date', () => {
    const start = new Date(2026, 9, 24, 8, 30);
    const end = new Date(2026, 9, 24, 9, 0);
    const label = start.toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    });

    // 47 hours after NOW: inside the window, but two calendar days out.
    const { text } = buildPayload({ calendar: [makeEvent('Planning', start, end)] });

    expect(text).toContain(`- Planning · ${label} ${formatTime(start)}–${formatTime(end)}`);
  });

  it('shows all-day events without times', () => {
    const allDay = (summary: string, startDate: string, endDate: string): GoogleCalendarEvent =>
      ({
        id: 2,
        summary,
        allDay: 1,
        startAt: `${startDate}T00:00:00.000Z`,
        endAt: `${endDate}T00:00:00.000Z`,
      }) as GoogleCalendarEvent;

    const { text } = buildPayload({
      calendar: [
        allDay('Offsite', '2026-10-22', '2026-10-23'),
        allDay('Holiday', '2026-10-23', '2026-10-24'),
        allDay('Last week', '2026-10-14', '2026-10-15'),
      ],
    });

    expect(text).toContain('- Offsite · Today · all day');
    expect(text).toContain('- Holiday · Tomorrow · all day');
    expect(text).not.toContain('Last week');
    expect(text).not.toMatch(/all day.*AM|PM.*all day/);
  });

  it('keeps only the last six history messages', () => {
    const history = Array.from({ length: 8 }, (_, index) => makeMessage(index));

    const { text } = buildPayload({ history });

    expect(text).not.toContain('message 1');
    expect(text).toContain('message 2');
    expect(text).toContain('message 7');
  });

  it('lays the sections out in order', () => {
    const { text } = buildPayload({
      question: 'Why?',
      notes: [makeNote({ id: 1, title: 'Plan', content: 'Body' })],
    });
    const positions = [
      'TODAY:',
      'CALENDAR (next 48 hours):',
      'NOTES:',
      'RECENT CHAT:',
      'USER QUESTION:',
    ].map((heading) => text.indexOf(heading));

    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(text).toMatch(/### Plan \(updated Oct 20\)\nBody/);
    expect(text.endsWith('USER QUESTION:\nWhy?')).toBe(true);
  });
});
