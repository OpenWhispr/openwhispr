import type {
  ChatCandidateNotes,
  ChatCandidateOptions,
  GoogleCalendarAccount,
  GoogleCalendarEvent,
  Note,
} from '@/data';
import { LocalReasoningError } from '@/lib/localReasoning';
import {
  createDefaultChatTurnDeps,
  runChatTurn,
  type ChatTurnDeps,
  type ChatTurnInput,
} from '../runChatTurn';
import type { ChatMessage, ChatStep } from '../types';

const mockGetNoteById = jest.fn();
const mockGetSegments = jest.fn();
const mockGetSpeakers = jest.fn();
const mockGetUpcomingEvents = jest.fn();
jest.mock('@/data', () => ({
  notesRepository: {
    getNoteById: mockGetNoteById,
    getSegments: mockGetSegments,
    getSpeakers: mockGetSpeakers,
  },
  calendarRepository: { getUpcomingEvents: mockGetUpcomingEvents },
}));

// Built with local-time constructors so assertions don't depend on the machine's timezone.
const NOW = new Date(2026, 9, 22, 9, 0, 0);

const formatTime = (date: Date): string =>
  date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

const makeNote = (overrides: Partial<Note> & { id: number }): Note =>
  ({
    title: 'Untitled',
    content: '',
    enhancedContent: null,
    isPrivate: 0,
    updatedAt: new Date(2026, 9, 20, 12, 0, 0).toISOString(),
    ...overrides,
  }) as Note;

const makeEvent = (
  summary: string | null,
  start: Date,
  end: Date,
  allDay = 0,
): GoogleCalendarEvent =>
  ({
    id: 1,
    summary,
    startAt: start.toISOString(),
    endAt: end.toISOString(),
    allDay,
  }) as GoogleCalendarEvent;

const CONNECTED_ACCOUNT = { id: 1, status: 'connected' } as GoogleCalendarAccount;

const PRICING = makeNote({ id: 1, title: 'Pricing call', content: 'Pricing stays at $12.' });
const ROADMAP = makeNote({ id: 2, title: 'Roadmap review', content: 'Pricing page ships in May.' });

const LOCAL_SELECTION = jest.fn(() => ({ mode: 'local' as const }));

const makeMessage = (
  id: string,
  role: ChatMessage['role'],
  text: string,
  sources: ChatMessage['sources'] = [],
): ChatMessage => ({ id, conversationId: 'c1', role, text, steps: [], sources, createdAt: 0 });

const PRIVATE_HISTORY: ChatMessage[] = [
  makeMessage('m1', 'user', 'What was the launch date?'),
  makeMessage('m2', 'assistant', 'Launch is June 3.', [{ noteId: 7, title: 'Launch plan' }]),
  makeMessage('m3', 'user', 'And the price?'),
  makeMessage('m4', 'assistant', 'Price stays at $12.', [{ noteId: 1, title: 'Pricing call' }]),
];

// Stands in for the repository: the matches for any terms or a period, the recent notes for
// neither, capped at the limit and counted before it.
const candidatesFrom = (matched: Note[], recent: Note[] = []) =>
  jest.fn((terms: string[], { limit, window }: ChatCandidateOptions): ChatCandidateNotes => {
    const notes = terms.length > 0 || window ? matched : recent;
    return { notes: notes.slice(0, limit), total: notes.length };
  });

const makeDeps = (overrides: Partial<ChatTurnDeps> = {}): ChatTurnDeps => ({
  getCandidateNotes: candidatesFrom([PRICING, ROADMAP]),
  getConnectedCalendarAccounts: jest.fn(() => [CONNECTED_ACCOUNT]),
  getCalendarEvents: jest.fn(() => []),
  isNotePrivate: jest.fn(() => false),
  getNoteTranscript: jest.fn(() => ''),
  chat: jest.fn(async () => ({ text: 'The answer.', model: 'test' })),
  getChatSelection: jest.fn(() => ({ mode: 'openwhispr' as const })),
  ...overrides,
});

const makeInput = (
  overrides: Partial<ChatTurnInput> = {},
): ChatTurnInput & { onSteps: jest.Mock<void, [ChatStep[]]> } => ({
  question: 'What did we decide on pricing?',
  history: [],
  signal: new AbortController().signal,
  allowCloudFallback: false,
  now: NOW,
  ...overrides,
  onSteps: jest.fn<void, [ChatStep[]]>(),
});

const lastSteps = (onSteps: jest.Mock<void, [ChatStep[]]>): ChatStep[] =>
  onSteps.mock.calls[onSteps.mock.calls.length - 1][0];

const sentText = (chat: ChatTurnDeps['chat'], call = 0): string =>
  (chat as jest.Mock).mock.calls[call][0].text;

describe('runChatTurn', () => {
  it('reports calendar, search, read and write steps in order', async () => {
    const deps = makeDeps({
      getCalendarEvents: jest.fn(() => [
        makeEvent('Standup', new Date(2026, 9, 22, 10, 0), new Date(2026, 9, 22, 10, 30)),
      ]),
    });
    const input = makeInput();

    const result = await runChatTurn(input, deps);

    const steps = lastSteps(input.onSteps);
    expect(steps.map((step) => step.id)).toEqual(['calendar', 'search', 'read', 'write']);
    expect(steps.every((step) => step.status === 'done')).toBe(true);
    expect(steps).toEqual([
      {
        id: 'calendar',
        status: 'done',
        label: 'Checked your calendar',
        detail: `Standup · ${formatTime(new Date(2026, 9, 22, 10, 0))}`,
      },
      { id: 'search', status: 'done', label: 'Searched your notes', detail: '2 notes match' },
      { id: 'read', status: 'done', label: 'Read “Pricing call” and 1 more' },
      { id: 'write', status: 'done', label: 'Wrote the answer' },
    ]);
    expect(result).toEqual({
      text: 'The answer.',
      steps,
      sources: [
        { noteId: 1, title: 'Pricing call' },
        { noteId: 2, title: 'Roadmap review' },
      ],
    });
    expect(deps.chat).toHaveBeenCalledWith(
      expect.objectContaining({
        routing: { allowCloudFallback: false },
        signal: input.signal,
        inferenceRoute: { mode: 'openwhispr', scope: 'noteChat' },
      }),
    );
  });

  it('starts each step active and sends a fresh list on every change', async () => {
    const input = makeInput();

    await runChatTurn(input, makeDeps());

    const calls = input.onSteps.mock.calls.map(([steps]) => steps);
    expect(calls[0]).toEqual([
      { id: 'calendar', status: 'active', label: 'Checking your calendar…' },
    ]);
    expect(calls).toContainEqual(
      expect.arrayContaining([
        { id: 'read', status: 'active', label: 'Reading “Pricing call” and 1 more…' },
      ]),
    );
    expect(lastSteps(input.onSteps)).not.toBe(calls[calls.length - 2]);
    expect(new Set(calls).size).toBe(calls.length);
  });

  it('skips the calendar step with no connected account', async () => {
    const deps = makeDeps({ getConnectedCalendarAccounts: jest.fn(() => []) });
    const input = makeInput();

    await runChatTurn(input, deps);

    expect(lastSteps(input.onSteps).map((step) => step.id)).toEqual(['search', 'read', 'write']);
    expect(deps.getCalendarEvents).not.toHaveBeenCalled();
    expect(sentText(deps.chat)).toContain('No calendar connected.');
  });

  it('describes an all-day next event and an untitled one', async () => {
    const allDay = makeDeps({
      getCalendarEvents: jest.fn(() => [
        makeEvent('Offsite', new Date(Date.UTC(2026, 9, 22)), new Date(Date.UTC(2026, 9, 23)), 1),
      ]),
    });
    const allDayInput = makeInput();
    await runChatTurn(allDayInput, allDay);
    expect(lastSteps(allDayInput.onSteps)[0].detail).toBe('Offsite · all day');

    const untitled = makeDeps({
      getCalendarEvents: jest.fn(() => [
        makeEvent(null, new Date(2026, 9, 22, 8, 0), new Date(2026, 9, 22, 8, 30)),
        makeEvent(null, new Date(2026, 9, 22, 11, 0), new Date(2026, 9, 22, 11, 30)),
      ]),
    });
    const untitledInput = makeInput();
    await runChatTurn(untitledInput, untitled);
    expect(lastSteps(untitledInput.onSteps)[0].detail).toBe(
      `Untitled meeting · ${formatTime(new Date(2026, 9, 22, 11, 0))}`,
    );
  });

  it('sends every meeting in the next 48 hours, not just the first few', async () => {
    const events = Array.from({ length: 8 }, (_, index) =>
      makeEvent(
        `Meeting ${index + 1}`,
        new Date(2026, 9, 22, 10 + index * 4, 0),
        new Date(2026, 9, 22, 10 + index * 4, 30),
      ),
    );
    mockGetUpcomingEvents.mockReturnValueOnce(events);
    const deps = makeDeps({ getCalendarEvents: createDefaultChatTurnDeps().getCalendarEvents });

    await runChatTurn(makeInput(), deps);

    const text = sentText(deps.chat);
    for (const event of events) expect(text).toContain(`- ${event.summary} · `);
  });

  it('says when no meetings are coming up but still sends the calendar section', async () => {
    const deps = makeDeps();
    const input = makeInput();

    await runChatTurn(input, deps);

    expect(lastSteps(input.onSteps)[0].detail).toBe('No meetings coming up');
    expect(sentText(deps.chat)).toContain('No meetings in the next 48 hours.');
  });

  it('sends no notes when nothing matches', async () => {
    const recent = makeNote({ id: 9, title: 'Weekly sync', content: 'Status updates.' });
    const getCandidateNotes = candidatesFrom([], [recent]);
    const input = makeInput({ question: 'What is the capital of France?' });
    const deps = makeDeps({ getCandidateNotes });

    const result = await runChatTurn(input, deps);

    expect(getCandidateNotes.mock.calls.map(([terms]) => terms)).toEqual([['capital', 'france']]);
    const steps = lastSteps(input.onSteps);
    expect(steps.map((step) => step.id)).toEqual(['calendar', 'search', 'write']);
    expect(steps.find((step) => step.id === 'search')?.detail).toBe('No matching notes');
    expect(result.sources).toEqual([]);
    expect(sentText(deps.chat)).toContain('NOTES:\nNo matching notes.');
  });

  it('reads the notes from a period the question names, whatever their words', async () => {
    const meetings = [
      makeNote({ id: 9, title: 'Weekly sync', content: 'Status updates.', noteType: 'meeting' }),
      makeNote({ id: 10, title: 'Standup', content: 'Blockers.', noteType: 'meeting' }),
    ];
    const getCandidateNotes = candidatesFrom(meetings);
    const input = makeInput({ question: 'Summarize my meetings this week' });

    const result = await runChatTurn(input, makeDeps({ getCandidateNotes }));

    expect(getCandidateNotes).toHaveBeenCalledTimes(1);
    expect(getCandidateNotes).toHaveBeenCalledWith([], {
      includePrivate: false,
      limit: 8,
      window: expect.objectContaining({
        start: new Date(2026, 9, 19),
        end: new Date(2026, 9, 23),
        meetingsOnly: true,
      }),
    });
    const steps = lastSteps(input.onSteps);
    expect(steps.find((step) => step.id === 'search')?.detail).toBe('2 meetings from this week');
    expect(steps.find((step) => step.id === 'read')?.label).toBe('Read “Weekly sync” and 1 more');
    expect(result.sources.map((source) => source.noteId)).toEqual([9, 10]);
  });

  describe('a period with words to search for', () => {
    const SEP_PRICING = makeNote({ id: 20, title: 'Pricing call', content: 'We kept $12.' });
    const THIS_WEEK = [
      makeNote({ id: 21, title: 'Groceries', content: 'Oat milk.' }),
      makeNote({ id: 22, title: 'Standup', content: 'Blockers.' }),
    ];
    // Matches in the period for terms with a window, every note of the period for no terms, and
    // older matches for terms without one.
    const repository = (
      inPeriod: Note[],
      older: Note[] = [SEP_PRICING],
    ): jest.Mock<ChatCandidateNotes, [string[], ChatCandidateOptions]> =>
      jest.fn((terms: string[], { window }: ChatCandidateOptions): ChatCandidateNotes => {
        const notes = !window ? older : terms.length > 0 ? inPeriod : THIS_WEEK;
        return { notes, total: notes.length };
      });
    const searchDetail = (input: ReturnType<typeof makeInput>): string | undefined =>
      lastSteps(input.onSteps).find((step) => step.id === 'search')?.detail;

    it('sends the period’s matching notes first, then the rest of the period', async () => {
      const getCandidateNotes = repository([THIS_WEEK[1]]);
      const input = makeInput({ question: 'What happened at standup this week?' });
      const deps = makeDeps({ getCandidateNotes });

      const result = await runChatTurn(input, deps);

      expect(
        getCandidateNotes.mock.calls.map(([terms, options]) => [terms, !!options.window]),
      ).toEqual([
        [['standup'], true],
        [[], true],
      ]);
      expect(result.sources.map((source) => source.noteId)).toEqual([22, 21]);
      expect(searchDetail(input)).toBe('2 notes from this week');
      expect(sentText(deps.chat)).toContain(
        'NOTES (2 of 2 notes from this week, matching ones first):',
      );
    });

    it('sends every note of a period the question names when none match', async () => {
      const getCandidateNotes = repository([]);
      const input = makeInput({ question: 'What did I spend on flights this week?' });
      const deps = makeDeps({ getCandidateNotes });

      const result = await runChatTurn(input, deps);

      expect(
        getCandidateNotes.mock.calls.map(([terms, options]) => [terms, !!options.window]),
      ).toEqual([
        [['spend', 'flights'], true],
        [[], true],
      ]);
      expect(result.sources.map((source) => source.noteId)).toEqual([21, 22]);
      expect(searchDetail(input)).toBe('2 notes from this week');
      expect(sentText(deps.chat)).toContain('NOTES (2 of 2 notes from this week, newest first):');
    });

    it('searches every note when nothing from “recently” matches', async () => {
      const getCandidateNotes = repository([]);
      const input = makeInput({ question: 'What was our most recent pricing decision?' });
      const deps = makeDeps({ getCandidateNotes });

      const result = await runChatTurn(input, deps);

      expect(
        getCandidateNotes.mock.calls.map(([terms, options]) => [terms, !!options.window]),
      ).toEqual([
        [['pricing', 'decision'], true],
        [['pricing', 'decision'], false],
      ]);
      expect(result.sources.map((source) => source.noteId)).toEqual([20]);
      expect(searchDetail(input)).toBe('1 note matches');
      expect(sentText(deps.chat)).toMatch(/\nNOTES:\n### Pricing call \(updated /);
    });

    it('reads the “recently” period when no note anywhere matches', async () => {
      const getCandidateNotes = repository([], []);
      const input = makeInput({ question: 'Anything about the roadmap lately?' });
      const deps = makeDeps({ getCandidateNotes });

      const result = await runChatTurn(input, deps);

      expect(
        getCandidateNotes.mock.calls.map(([terms, options]) => [terms, !!options.window]),
      ).toEqual([
        [['roadmap'], true],
        [['roadmap'], false],
        [[], true],
      ]);
      expect(result.sources.map((source) => source.noteId)).toEqual([21, 22]);
      expect(searchDetail(input)).toBe('2 notes from the last 7 days');
      expect(sentText(deps.chat)).toContain(
        'NOTES (2 of 2 notes from the last 7 days, newest first):',
      );
    });

    it('counts no empty match, so “recently” still searches every note', async () => {
      const failed = makeNote({ id: 23, title: 'Pricing call' });
      const getCandidateNotes = repository([failed]);
      const input = makeInput({ question: 'What was our most recent pricing decision?' });

      const result = await runChatTurn(input, makeDeps({ getCandidateNotes }));

      expect(result.sources.map((source) => source.noteId)).toEqual([20]);
      expect(searchDetail(input)).toBe('1 note matches');
    });
  });

  it('says when a period holds nothing', async () => {
    const empty = makeInput({ question: 'What happened yesterday?' });
    await runChatTurn(empty, makeDeps({ getCandidateNotes: candidatesFrom([]) }));
    expect(lastSteps(empty.onSteps).find((step) => step.id === 'search')?.detail).toBe(
      'No notes from yesterday',
    );

    const one = makeInput({ question: 'Any meeting today?' });
    await runChatTurn(one, makeDeps({ getCandidateNotes: candidatesFrom([PRICING]) }));
    expect(lastSteps(one.onSteps).find((step) => step.id === 'search')?.detail).toBe(
      '1 meeting from today',
    );
  });

  it('reads only the notes it sends, and says how many matched in all', async () => {
    const matched = [3, 4, 5, 6, 7, 8, 9].map((id) =>
      makeNote({ id, title: `Pricing ${id}`, content: 'Pricing notes.' }),
    );
    const getCandidateNotes = candidatesFrom(matched);
    const input = makeInput();

    const result = await runChatTurn(input, makeDeps({ getCandidateNotes }));

    expect(getCandidateNotes).toHaveBeenCalledWith(
      expect.arrayContaining(['pricing']),
      expect.objectContaining({ limit: 8 }),
    );
    expect(result.sources.map((source) => source.noteId)).toEqual([3, 4, 5, 6]);
    expect(lastSteps(input.onSteps).find((step) => step.id === 'search')?.detail).toBe(
      '7 notes match',
    );
  });

  it('lets the next match take an empty match’s place', async () => {
    const failed = makeNote({ id: 2, title: 'Pricing call' });
    const matched = [
      failed,
      ...[3, 4, 5, 6].map((id) =>
        makeNote({ id, title: `Pricing ${id}`, content: 'Pricing notes.' }),
      ),
    ];

    const result = await runChatTurn(
      makeInput(),
      makeDeps({ getCandidateNotes: candidatesFrom(matched) }),
    );

    expect(result.sources.map((source) => source.noteId)).toEqual([3, 4, 5, 6]);
  });

  it('reads no transcript past the matches it sends', async () => {
    const meetings = [2, 3, 4, 5, 6, 7].map((id) => makeNote({ id, title: `Pricing sync ${id}` }));
    const getNoteTranscript = jest.fn((_noteId: number) => 'We agreed on pricing.');

    const result = await runChatTurn(
      makeInput(),
      makeDeps({ getCandidateNotes: candidatesFrom(meetings), getNoteTranscript }),
    );

    expect(result.sources.map((source) => source.noteId)).toEqual([2, 3, 4, 5]);
    expect(getNoteTranscript.mock.calls.map(([id]) => id)).toEqual([2, 3, 4, 5]);
  });

  it('passes over empty notes from a period', async () => {
    const failed = makeNote({ id: 8, title: 'Failed recording' });
    const recent = [
      failed,
      makeNote({ id: 9, title: 'Weekly sync', content: 'Status updates.' }),
      makeNote({ id: 10, title: 'Standup', content: 'Blockers.' }),
    ];
    const getNoteTranscript = jest.fn(() => '');

    const result = await runChatTurn(
      makeInput({ question: 'Anything new today?' }),
      makeDeps({ getCandidateNotes: candidatesFrom(recent), getNoteTranscript }),
    );

    expect(getNoteTranscript).toHaveBeenCalledWith(8);
    expect(result.sources.map((source) => source.noteId)).toEqual([9, 10]);
  });

  it('never queries with a blank term and reads no notes when there are none', async () => {
    const getCandidateNotes = candidatesFrom([]);
    const input = makeInput({ question: 'Is it?' });

    await runChatTurn(input, makeDeps({ getCandidateNotes }));

    expect(getCandidateNotes.mock.calls.every(([terms]) => !terms.includes(''))).toBe(true);
    expect(getCandidateNotes.mock.calls.filter(([terms]) => terms.length > 0)).toHaveLength(0);
    expect(lastSteps(input.onSteps).map((step) => step.id)).toEqual([
      'calendar',
      'search',
      'write',
    ]);
  });

  it('never sends private notes on a cloud route', async () => {
    const secret = makeNote({
      id: 3,
      title: 'Secret pricing plan',
      content: 'Pricing',
      isPrivate: 1,
    });
    const getCandidateNotes = candidatesFrom([secret, PRICING], [secret, PRICING]);
    const deps = makeDeps({ getCandidateNotes });

    const result = await runChatTurn(makeInput(), deps);

    for (const [, options] of getCandidateNotes.mock.calls as unknown as [
      string[],
      { includePrivate: boolean },
    ][]) {
      expect(options.includePrivate).toBe(false);
    }
    expect(sentText(deps.chat)).not.toContain('Secret pricing plan');
    expect(result.sources.map((source) => source.noteId)).not.toContain(3);
  });

  it('includes private notes on a local route', async () => {
    const secret = makeNote({
      id: 3,
      title: 'Secret pricing plan',
      content: 'Pricing',
      isPrivate: 1,
    });
    const getCandidateNotes = candidatesFrom([secret], [secret]);
    const deps = makeDeps({ getCandidateNotes, getChatSelection: LOCAL_SELECTION });

    await runChatTurn(makeInput(), deps);

    expect(getCandidateNotes).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ includePrivate: true }),
    );
    expect(sentText(deps.chat)).toContain('Secret pricing plan');
    expect(deps.chat).toHaveBeenCalledWith(
      expect.objectContaining({
        routing: { allowCloudFallback: false, isPrivateNote: true },
        inferenceRoute: { mode: 'local', scope: 'noteChat' },
      }),
    );
  });

  it('sends no history on a cloud route once an answer used a private note', async () => {
    const isNotePrivate = jest.fn((noteId: number) => noteId === 7);
    const deps = makeDeps({ isNotePrivate });

    await runChatTurn(makeInput({ history: PRIVATE_HISTORY }), deps);

    const text = sentText(deps.chat);
    expect(text).toContain('RECENT CHAT:\nNo prior chat messages.');
    expect(text).not.toContain('Launch is June 3.');
    expect(text).not.toContain('Price stays at $12.');
  });

  it('treats a missing source note as private on a cloud route', async () => {
    mockGetNoteById.mockImplementation((noteId: number) => (noteId === 1 ? PRICING : null));
    const deps = makeDeps({ isNotePrivate: createDefaultChatTurnDeps().isNotePrivate });

    await runChatTurn(makeInput({ history: PRIVATE_HISTORY }), deps);

    expect(mockGetNoteById).toHaveBeenCalledWith(7);
    expect(sentText(deps.chat)).toContain('RECENT CHAT:\nNo prior chat messages.');
  });

  it('keeps history whose source notes are all present and shared', async () => {
    mockGetNoteById.mockImplementation((noteId: number) => makeNote({ id: noteId }));
    const deps = makeDeps({ isNotePrivate: createDefaultChatTurnDeps().isNotePrivate });

    await runChatTurn(makeInput({ history: PRIVATE_HISTORY }), deps);

    expect(sentText(deps.chat)).toContain('Launch is June 3.');
  });

  it('drops all history once any answer used a private note', async () => {
    const history = [
      makeMessage('m1', 'user', 'What was the launch date?'),
      makeMessage('m2', 'assistant', 'Launch is June 3.', [{ noteId: 7, title: 'Launch plan' }]),
      makeMessage('m3', 'user', 'Repeat that?'),
      makeMessage('m4', 'assistant', 'As I said, launch is June 3.'),
    ];
    const deps = makeDeps({ isNotePrivate: jest.fn((noteId: number) => noteId === 7) });

    await runChatTurn(makeInput({ history }), deps);

    const text = sentText(deps.chat);
    expect(text).toContain('RECENT CHAT:\nNo prior chat messages.');
    expect(text).not.toContain('As I said, launch is June 3.');
  });

  it('sends no history on a cloud route once an answer’s sources can’t be read', async () => {
    const history = [
      makeMessage('m1', 'user', 'What was the launch date?'),
      { ...makeMessage('m2', 'assistant', 'Launch is June 3.'), sourcesUnreadable: true },
    ];
    const deps = makeDeps();

    await runChatTurn(makeInput({ history }), deps);

    expect(sentText(deps.chat)).toContain('RECENT CHAT:\nNo prior chat messages.');
  });

  it('sends the transcript of a matched meeting that has no summary', async () => {
    const meeting = makeNote({ id: 3, title: 'Weekly sync', noteType: 'meeting' });
    const getNoteTranscript = jest.fn(() => 'Meeting transcript:\n[00:00] Priya: Pricing holds.');
    const deps = makeDeps({
      getCandidateNotes: candidatesFrom([meeting, PRICING]),
      getNoteTranscript,
    });

    await runChatTurn(makeInput(), deps);

    expect(getNoteTranscript).toHaveBeenCalledTimes(1);
    expect(getNoteTranscript).toHaveBeenCalledWith(3);
    expect(sentText(deps.chat)).toContain('### Weekly sync');
    expect(sentText(deps.chat)).toContain('[00:00] Priya: Pricing holds.');
  });

  it('keeps the repository’s ranking, so a meeting matched in its transcript stays in', async () => {
    const meeting = makeNote({ id: 3, title: 'Leadership sync', noteType: 'meeting' });
    const bodyHits = [4, 5, 6, 7].map((id) =>
      makeNote({ id, title: `Update ${id}`, content: 'A hiring update.' }),
    );
    const deps = makeDeps({
      getCandidateNotes: candidatesFrom([meeting, ...bodyHits]),
      getNoteTranscript: jest.fn(
        () => 'Meeting transcript:\n[0:00] Priya: The hiring freeze holds.',
      ),
    });

    const result = await runChatTurn(makeInput({ question: 'Is the hiring freeze on?' }), deps);

    expect(result.sources.map((source) => source.noteId)).toEqual([3, 4, 5, 6]);
    expect(sentText(deps.chat)).toContain('The hiring freeze holds.');
  });

  it('formats a transcript from the note’s segments and speakers', () => {
    mockGetSegments.mockReturnValueOnce([
      {
        id: 1,
        noteId: 3,
        startMs: 0,
        endMs: 1000,
        text: 'Pricing holds.',
        speakerLabel: 'S1',
        sortOrder: 0,
      },
    ]);
    mockGetSpeakers.mockReturnValueOnce([
      { id: 1, noteId: 3, speakerLabel: 'S1', displayName: 'Priya', sortOrder: 0 },
    ]);

    expect(createDefaultChatTurnDeps().getNoteTranscript(3)).toBe(
      'Meeting transcript:\n[0:00] Priya: Pricing holds.',
    );
    mockGetSegments.mockReturnValueOnce([]);
    expect(createDefaultChatTurnDeps().getNoteTranscript(4)).toBe('');
  });

  it('reads the calendar from a day back, so today’s all-day events stay in', () => {
    mockGetUpcomingEvents.mockReturnValue([]);

    createDefaultChatTurnDeps().getCalendarEvents([CONNECTED_ACCOUNT], NOW);

    expect(mockGetUpcomingEvents).toHaveBeenCalledWith(
      CONNECTED_ACCOUNT.id,
      new Date(NOW.getTime() - 24 * 60 * 60 * 1000).toISOString(),
      expect.any(String),
    );
  });

  it('keeps history answers built from private notes on a local route', async () => {
    const isNotePrivate = jest.fn((noteId: number) => noteId === 7);
    const deps = makeDeps({ isNotePrivate, getChatSelection: LOCAL_SELECTION });

    await runChatTurn(makeInput({ history: PRIVATE_HISTORY }), deps);

    const text = sentText(deps.chat);
    expect(text).toContain('What was the launch date?');
    expect(text).toContain('Launch is June 3.');
    expect(isNotePrivate).not.toHaveBeenCalled();
  });

  it('retries a local context-limit error with one short note', async () => {
    const chat = jest
      .fn()
      .mockRejectedValueOnce(new LocalReasoningError('LOCAL_CONTEXT_LIMIT', 'Too long'))
      .mockResolvedValueOnce({ text: 'Short answer.', model: 'local' });
    const deps = makeDeps({ chat, getChatSelection: LOCAL_SELECTION });

    const result = await runChatTurn(makeInput(), deps);

    expect(chat).toHaveBeenCalledTimes(2);
    expect(sentText(chat, 0).match(/###/g)).toHaveLength(2);
    expect(sentText(chat, 1).match(/###/g)).toHaveLength(1);
    expect(result.text).toBe('Short answer.');
    expect(result.sources).toEqual([{ noteId: 1, title: 'Pricing call' }]);
  });

  it('drops the chat history from a context-limit retry', async () => {
    const history = [
      makeMessage('m1', 'user', 'What was the launch date?'),
      makeMessage('m2', 'assistant', 'Launch is June 3.'),
    ];
    const chat = jest
      .fn()
      .mockRejectedValueOnce(new LocalReasoningError('LOCAL_CONTEXT_LIMIT', 'Too long'))
      .mockResolvedValueOnce({ text: 'Short answer.', model: 'local' });
    const deps = makeDeps({ chat, getChatSelection: LOCAL_SELECTION });

    await runChatTurn(makeInput({ history }), deps);

    expect(sentText(chat, 0)).toContain('Launch is June 3.');
    expect(sentText(chat, 1)).toContain('RECENT CHAT:\nNo prior chat messages.');
  });

  it('skips a context-limit retry that would send the same request', async () => {
    const error = new LocalReasoningError('LOCAL_CONTEXT_LIMIT', 'Too long');
    const chat = jest.fn().mockRejectedValue(error);
    const deps = makeDeps({
      chat,
      getChatSelection: LOCAL_SELECTION,
      getCandidateNotes: candidatesFrom([PRICING]),
    });

    await expect(runChatTurn(makeInput(), deps)).rejects.toBe(error);
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it('retries a long note cut to the budget', async () => {
    const long = makeNote({
      id: 5,
      title: 'Pricing deep dive',
      content: `Pricing ${'p'.repeat(4_500)}`,
      updatedAt: new Date(2026, 9, 21, 12, 0, 0).toISOString(),
    });
    const chat = jest
      .fn()
      .mockRejectedValueOnce(new LocalReasoningError('LOCAL_CONTEXT_LIMIT', 'Too long'))
      .mockResolvedValueOnce({ text: 'Short answer.', model: 'local' });
    const input = makeInput();
    const deps = makeDeps({
      chat,
      getChatSelection: LOCAL_SELECTION,
      getCandidateNotes: candidatesFrom([long, PRICING]),
    });

    const result = await runChatTurn(input, deps);

    expect(sentText(chat, 0).match(/^### /gm)).toHaveLength(2);
    const retryText = sentText(chat, 1);
    expect(retryText.match(/^### /gm)).toHaveLength(1);
    const longestRun = Math.max(...(retryText.match(/p{10,}/g) ?? ['']).map((run) => run.length));
    expect(longestRun).toBeGreaterThan(2_500);
    expect(longestRun).toBeLessThanOrEqual(3_000);
    expect(result.sources).toEqual([{ noteId: 5, title: 'Pricing deep dive' }]);
    expect(lastSteps(input.onSteps).find((step) => step.id === 'read')).toEqual({
      id: 'read',
      status: 'done',
      label: 'Read “Pricing deep dive”',
    });
    expect(lastSteps(input.onSteps).map((step) => step.id)).toEqual([
      'calendar',
      'search',
      'read',
      'write',
    ]);
  });

  it('uses one route snapshot for both calls', async () => {
    const getChatSelection = jest
      .fn()
      .mockReturnValueOnce({ mode: 'local' })
      .mockReturnValue({ mode: 'openwhispr' });
    const chat = jest.fn(async () => {
      if (chat.mock.calls.length === 1) {
        throw new LocalReasoningError('LOCAL_CONTEXT_LIMIT', 'Too long');
      }
      return { text: 'Short answer.', model: 'local' };
    });

    await runChatTurn(makeInput(), makeDeps({ chat, getChatSelection }));

    expect(chat).toHaveBeenCalledTimes(2);
    for (const [request] of chat.mock.calls as unknown as [{ inferenceRoute: unknown }][]) {
      expect(request.inferenceRoute).toEqual({ mode: 'local', scope: 'noteChat' });
    }
  });

  it('passes a provider selection through as the route', async () => {
    const deps = makeDeps({
      getChatSelection: jest.fn(() => ({
        mode: 'providers' as const,
        providerId: 'openai',
        modelId: 'gpt-5-mini',
        credentialRef: 'openai-key',
      })),
    });

    await runChatTurn(makeInput(), deps);

    expect(deps.chat).toHaveBeenCalledWith(
      expect.objectContaining({
        inferenceRoute: {
          mode: 'providers',
          scope: 'noteChat',
          providerId: 'openai',
          modelId: 'gpt-5-mini',
          endpoint: '',
          credentialRef: 'openai-key',
        },
      }),
    );
  });

  it("keeps going when the calendar can't be read", async () => {
    for (const broken of [
      {
        getConnectedCalendarAccounts: jest.fn((): GoogleCalendarAccount[] => {
          throw new Error('store unavailable');
        }),
      },
      {
        getCalendarEvents: jest.fn((): GoogleCalendarEvent[] => {
          throw new Error('SQLITE_BUSY');
        }),
      },
    ]) {
      const deps = makeDeps(broken);
      const input = makeInput();

      const result = await runChatTurn(input, deps);

      expect(result.text).toBe('The answer.');
      expect(lastSteps(input.onSteps).map((step) => step.id)).toEqual(['search', 'read', 'write']);
      expect(sentText(deps.chat)).toContain('Calendar unavailable right now.');
      expect(sentText(deps.chat)).not.toContain('No calendar connected.');
    }
  });

  it('describes only meetings inside the next 48 hours', async () => {
    const deps = makeDeps({
      getCalendarEvents: jest.fn(() => [
        makeEvent('Planning', new Date(2026, 9, 25, 10, 0), new Date(2026, 9, 25, 11, 0)),
      ]),
    });
    const input = makeInput();

    await runChatTurn(input, deps);

    expect(lastSteps(input.onSteps)[0].detail).toBe('No meetings coming up');
  });

  it('rethrows other model errors without retrying', async () => {
    const chat = jest.fn().mockRejectedValue(new Error('Network down'));

    await expect(runChatTurn(makeInput(), makeDeps({ chat }))).rejects.toThrow('Network down');
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it('stops after an abort', async () => {
    const controller = new AbortController();
    const getCandidateNotes = jest.fn(() => {
      controller.abort();
      return { notes: [PRICING], total: 1 };
    });
    const deps = makeDeps({ getCandidateNotes });

    const promise = runChatTurn(makeInput({ signal: controller.signal }), deps);

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(deps.chat).not.toHaveBeenCalled();
  });

  it('does not retry or resolve once aborted during the model call', async () => {
    const controller = new AbortController();
    const chat = jest.fn(async () => {
      controller.abort();
      throw new LocalReasoningError('LOCAL_CONTEXT_LIMIT', 'Too long');
    });

    await expect(
      runChatTurn(makeInput({ signal: controller.signal }), makeDeps({ chat })),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(chat).toHaveBeenCalledTimes(1);
  });
});
