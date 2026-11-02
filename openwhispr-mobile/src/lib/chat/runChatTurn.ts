import type {
  ChatCandidateNotes,
  ChatCandidateOptions,
  GoogleCalendarAccount,
  GoogleCalendarEvent,
  Note,
} from '@/data';
import type { InferenceRoute, InferenceSelection } from '@/lib/mobileProviders';
import { isLocalContextLimitError } from '@/lib/localReasoning';
import { tryParseNoteTimestamp } from '@/lib/parseNoteTimestamp';
import { abortError } from '@/services/providers/NativeProviderTransport';
import type { ReasoningResponse, ReasoningRoutingOptions } from '@/types';
import {
  countPeriodNotes,
  formatChatTime,
  isInChatCalendarWindow,
  lacksNoteText,
  markCitedSources,
  parseChatQuery,
  type ChatCalendar,
  type ChatFollowUp,
  type ChatNotesPeriod,
  type ChatPayload,
  type ChatQuery,
  type ChatTimeScope,
} from './chatContext';
import { ChatEmptyAnswerError, ChatNotesReadError } from './chatErrorMessage';
import type { ChatMessage, ChatSource, ChatStep, ChatStepId } from './types';
import { buildBudgetedChatPayload, resolveChatBudget } from './chatBudget';

const NO_NOTES: ChatCandidateNotes = { notes: [], total: 0 };
const CONTEXT_LIMIT_NOTE_CHAR_BUDGET = 3_000;
// An all-day event is stored as UTC midnight to UTC midnight, so west of UTC today's ends before
// the local day does. A day's lookback keeps it; chatContext drops the events that have ended.
const CHAT_CALENDAR_LOOKBACK_MS = 24 * 60 * 60 * 1000;

export interface ChatTurnInput {
  question: string;
  history: ChatMessage[];
  signal: AbortSignal;
  allowCloudFallback: boolean;
  onSteps: (steps: ChatStep[]) => void;
  now?: Date;
}

export interface ChatTurnResult {
  text: string;
  steps: ChatStep[];
  sources: ChatSource[];
}

export interface ChatModelRequest {
  systemPrompt: string;
  text: string;
  signal?: AbortSignal;
  routing?: ReasoningRoutingOptions;
  inferenceRoute?: InferenceRoute;
}

export interface ChatTurnDeps {
  getCandidateNotes: (terms: string[], options: ChatCandidateOptions) => ChatCandidateNotes;
  /** The note as stored, deleted or not, or null when there is none. */
  getNote: (noteId: number) => Note | null;
  isNotePrivate: (noteId: number) => boolean;
  /** The note's transcript, formatted for a model, or '' when it has none. */
  getNoteTranscript: (noteId: number) => string;
  getConnectedCalendarAccounts: () => GoogleCalendarAccount[];
  getCalendarEvents: (accounts: GoogleCalendarAccount[], now: Date) => GoogleCalendarEvent[];
  chat: (request: ChatModelRequest) => Promise<ReasoningResponse>;
  getChatSelection: () => InferenceSelection | undefined;
}

// Required lazily, as ReasoningService does, so importing this module doesn't pull SQLite and the
// stores into the chat store's import graph.
export const createDefaultChatTurnDeps = (): ChatTurnDeps => ({
  getCandidateNotes: (terms, options) => {
    const { notesRepository } = require('@/data') as typeof import('@/data');
    return notesRepository.getChatCandidateNotes(terms, options);
  },
  getNote: (noteId) => {
    const { notesRepository } = require('@/data') as typeof import('@/data');
    return notesRepository.getNoteById(noteId);
  },
  isNotePrivate: (noteId) => {
    const { notesRepository } = require('@/data') as typeof import('@/data');
    // Missing, deleted and revoked notes are no longer eligible to supply cloud context,
    // including excerpts retained in earlier answers.
    const note = notesRepository.getNoteById(noteId);
    return note == null || note.isPrivate === 1 || !!note.deletedAt || note.leftTeam === 1;
  },
  getNoteTranscript: (noteId) => {
    const { notesRepository } = require('@/data') as typeof import('@/data');
    const segments = notesRepository.getSegments(noteId);
    if (segments.length === 0) return '';
    const { formatTranscriptForExport } =
      require('@/lib/diarization/transcriptDisplay') as typeof import('@/lib/diarization/transcriptDisplay');
    const { buildMeetingNotesInput } =
      require('@/lib/notes/meetingNotesInput') as typeof import('@/lib/notes/meetingNotesInput');
    // Formatted as the note's own chat sends it; the note's title already heads its block.
    return buildMeetingNotesInput({
      transcript: formatTranscriptForExport({
        segments,
        speakers: notesRepository.getSpeakers(noteId),
      }),
    });
  },
  getConnectedCalendarAccounts: () => {
    const { useGoogleCalendarStore } =
      require('@/store/useGoogleCalendarStore') as typeof import('@/store/useGoogleCalendarStore');
    return useGoogleCalendarStore
      .getState()
      .accounts.filter((account) => account.status === 'connected');
  },
  getCalendarEvents: (accounts, now) => {
    const { calendarRepository } = require('@/data') as typeof import('@/data');
    const { getMeetingCalendarEventSuggestions } =
      require('@/lib/calendar/meetingSuggestions') as typeof import('@/lib/calendar/meetingSuggestions');
    return getMeetingCalendarEventSuggestions(
      accounts,
      calendarRepository,
      now,
      // The repository already reads the bounded seven-day cache. Limit the formatted
      // prompt instead, so later events aren't silently lost before omissions are counted.
      Infinity,
      CHAT_CALENDAR_LOOKBACK_MS,
    );
  },
  chat: (request) => {
    const { ReasoningService } =
      require('@/services/reasoning/ReasoningService') as typeof import('@/services/reasoning/ReasoningService');
    return ReasoningService.chat(request);
  },
  getChatSelection: () => {
    const { getInferenceSelection } =
      require('@/lib/inferenceRouting') as typeof import('@/lib/inferenceRouting');
    return getInferenceSelection('noteChat');
  },
});

// Hermes has no DOMException, so the abort is the plain AbortError the provider transport throws.
const throwIfAborted = (signal: AbortSignal): void => {
  if (signal.aborted) throw abortError('Aborted');
};

// The notes are read on this phone, so a failure there is reported as one rather than as the
// connection problem an unrecognised error reads as.
const readNotes = <T>(read: () => T): T => {
  try {
    return read();
  } catch (error) {
    throw new ChatNotesReadError(error);
  }
};

// ReasoningService treats an inferenceRoute as the selection it would otherwise look up, and
// validates a provider route itself, so this only gives the selection the route's shape. No
// selection means OpenWhispr Cloud, which is what ReasoningService.chat does without one.
const toChatRoute = (selection: InferenceSelection | undefined): InferenceRoute => {
  if (selection?.mode !== 'providers') {
    return { mode: selection?.mode ?? 'openwhispr', scope: 'noteChat' };
  }
  return {
    ...selection,
    mode: 'providers',
    scope: 'noteChat',
    providerId: selection.providerId ?? '',
    modelId: selection.modelId ?? '',
    endpoint: selection.endpoint ?? '',
  };
};

// A later answer can quote one built from a private note without listing that note (one made on
// a local route, say), so a single such answer keeps the whole conversation out of the request.
// An answer whose sources can't be read may have used one too.
const usedPrivateNote = (
  history: ChatMessage[],
  isNotePrivate: (noteId: number) => boolean,
): boolean =>
  history.some(
    (message) =>
      message.role === 'assistant' &&
      (message.sourcesUnreadable === true ||
        message.sources.some((source) => isNotePrivate(source.noteId))),
  );

// A calendar that can't be read is reported as unavailable, and the notes can still answer.
const readAccounts = (deps: ChatTurnDeps): GoogleCalendarAccount[] | null => {
  try {
    return deps.getConnectedCalendarAccounts();
  } catch {
    return null;
  }
};

const readEvents = (
  deps: ChatTurnDeps,
  accounts: GoogleCalendarAccount[],
  now: Date,
): GoogleCalendarEvent[] | null => {
  try {
    return deps.getCalendarEvents(accounts, now);
  } catch {
    return null;
  }
};

const describeNextEvent = (
  events: GoogleCalendarEvent[],
  now: Date,
  windowHours: number,
): string => {
  const next = events.find((event) => isInChatCalendarWindow(event, now, windowHours));
  if (!next) return 'No meetings coming up';

  const summary = next.summary?.trim() || 'Untitled meeting';
  if (next.allDay) return `${summary} · all day`;
  const start = tryParseNoteTimestamp(next.startAt);
  return start ? `${summary} · ${formatChatTime(start)}` : summary;
};

interface FoundNotes {
  /** The notes to send. */
  notes: Note[];
  /** How many notes match, or with a period how many it holds. */
  total: number;
  /** Null when the notes were searched for across every note. */
  period: ChatNotesPeriod | null;
  /** Set when the notes are the ones the latest answer named, read again for a follow-up. */
  followUp?: ChatFollowUp;
}

// A follow-up naming no topic or period of its own ("Is that really in the meeting?") is about
// the notes the latest answer named, so they're read again, with the transcript lines the
// question that found them matched. An answer that named none leaves nothing to carry.
const findFollowUp = (history: ChatMessage[], now: Date): ChatFollowUp | null => {
  const index = history.map((message) => message.role).lastIndexOf('assistant');
  const answer = history[index];
  if (!answer || answer.sourcesUnreadable) return null;
  const noteIds = answer.sources
    .filter((source) => source.cited !== false)
    .map((source) => source.noteId);
  if (noteIds.length === 0) return null;
  // Topic-free follow-ups inherit the question that found these notes. Stop at a new period
  // or a break in the citations, so an unrelated earlier topic cannot supply their passages.
  for (let questionIndex = index - 1; questionIndex >= 0; questionIndex -= 2) {
    const asked = history[questionIndex];
    if (asked.role !== 'user') break;
    const query = parseChatQuery(asked.text, now);
    if (query.terms.length > 0 || query.scope) return { noteIds, terms: query.terms };
    const previous = history[questionIndex - 1];
    if (
      previous?.role !== 'assistant' ||
      previous.sourcesUnreadable ||
      !noteIds.every((noteId) =>
        previous.sources.some((source) => source.noteId === noteId && source.cited !== false),
      )
    ) {
      break;
    }
  }
  return { noteIds, terms: [] };
};

// A period's notes are all read, the ones matching the question's words first, since the words
// that ask about a period ("What did I work on today?") rarely name what is in it. "Recently" only
// hints at a period, so when none of its notes match, every note is searched, and its notes are
// read only when that finds nothing either. A note is found only once `pick` keeps it, so an
// empty match (a failed recording) decides nothing.
const findNotes = (
  { terms, scope }: ChatQuery,
  find: (terms: string[], window?: ChatTimeScope) => ChatCandidateNotes,
  pick: (notes: Note[]) => Note[],
): FoundNotes => {
  const searchAll = (): FoundNotes => {
    const found = terms.length > 0 ? find(terms) : NO_NOTES;
    return { notes: pick(found.notes), total: found.total, period: null };
  };
  if (!scope) return searchAll();

  const matches = terms.length > 0 ? pick(find(terms, scope).notes) : [];
  if (matches.length === 0 && scope.soft) {
    const everywhere = searchAll();
    if (everywhere.notes.length > 0) return everywhere;
  }
  const inPeriod = find([], scope);
  const matchIds = new Set(matches.map((note) => note.id));
  return {
    notes: pick([...matches, ...inPeriod.notes.filter((note) => !matchIds.has(note.id))]),
    total: inPeriod.total,
    period: { scope, total: inPeriod.total, matched: matches.length > 0 },
  };
};

const describeFound = ({ total, period, followUp }: FoundNotes): string => {
  if (followUp) return `${total} ${total === 1 ? 'note' : 'notes'} from the last answer`;
  if (period) {
    const { scope } = period;
    if (total === 0) return `No ${scope.meetingsOnly ? 'meeting' : 'note'}s from ${scope.label}`;
    return countPeriodNotes(total, scope);
  }
  if (total === 0) return 'No matching notes';
  if (total === 1) return '1 note matches';
  return `${total} notes match`;
};

const describeReading = (sources: ChatSource[]): { active: string; done: string } => {
  const title = `“${sources[0].title}”`;
  const more = sources.length > 1 ? ` and ${sources.length - 1} more` : '';
  return { active: `Reading ${title}${more}…`, done: `Read ${title}${more}` };
};

export async function runChatTurn(
  input: ChatTurnInput,
  deps: ChatTurnDeps = createDefaultChatTurnDeps(),
): Promise<ChatTurnResult> {
  const { question, signal, allowCloudFallback, onSteps, now = new Date() } = input;
  const steps: ChatStep[] = [];
  const setStep = (step: ChatStep): void => {
    const index = steps.findIndex((existing) => existing.id === step.id);
    if (index === -1) {
      steps.push(step);
    } else {
      const previous = steps[index];
      const activeLabel =
        step.activeLabel ??
        previous.activeLabel ??
        (previous.status === 'active' ? previous.label : undefined);
      steps[index] = step.status === 'done' && activeLabel ? { ...step, activeLabel } : step;
    }
    onSteps([...steps]);
  };
  const removeStep = (id: ChatStepId): void => {
    const index = steps.findIndex((existing) => existing.id === id);
    if (index === -1) return;
    steps.splice(index, 1);
    onSteps([...steps]);
  };

  throwIfAborted(signal);
  // Read once, so the notes picked for this route and the route that receives them can't diverge.
  const selection = deps.getChatSelection();
  const inferenceRoute = toChatRoute(selection);
  const query = parseChatQuery(question, now);
  const budget = await resolveChatBudget(inferenceRoute, !!query.scope && query.terms.length === 0);
  throwIfAborted(signal);
  const maxNotes = budget?.maxNotes ?? 4;
  // Spare candidates let empty recordings be skipped without losing useful matches.
  const matchPool = maxNotes * 2;
  const calendarWindowHours =
    inferenceRoute.mode !== 'providers' &&
    /\b(?:calendar|schedule|meetings?|busy|free)\b/i.test(question) &&
    /\b(?:(?:this|next|coming)\s+week|next\s+(?:7|seven)\s+days)\b/i.test(question)
      ? 168
      : 48;
  const includePrivate = selection?.mode === 'local';
  // The repository already filters private notes; this keeps them out whatever it returns.
  const allowed = (notes: Note[]): Note[] =>
    includePrivate ? notes : notes.filter((note) => note.isPrivate !== 1);
  const history =
    includePrivate || !readNotes(() => usedPrivateNote(input.history, deps.isNotePrivate))
      ? input.history
      : [];

  const accounts = readAccounts(deps);
  let calendar: ChatCalendar = accounts === null ? 'unavailable' : null;
  if (accounts && accounts.length > 0) {
    setStep({ id: 'calendar', status: 'active', label: 'Checking your calendar…' });
    const events = readEvents(deps, accounts, now);
    if (events === null) {
      calendar = 'unavailable';
      removeStep('calendar');
    } else {
      calendar = events;
      setStep({
        id: 'calendar',
        status: 'done',
        label: 'Checked your calendar',
        detail: describeNextEvent(events, now, calendarWindowHours),
      });
    }
    throwIfAborted(signal);
  }

  setStep({ id: 'search', status: 'active', label: 'Searching your notes…' });
  // Transcripts of the notes with no text of their own, read once whether a note is sent or passed
  // over for having nothing in it, and of the notes sent that matched in their transcript.
  const transcripts = new Map<number, string>();
  const transcriptMatches = new Set<number>();
  const hasContent = (note: Note): boolean => {
    if (!lacksNoteText(note)) return true;
    const transcript = transcripts.get(note.id) ?? deps.getNoteTranscript(note.id);
    transcripts.set(note.id, transcript);
    return transcript.trim() !== '';
  };
  // The repository ranks by how well, and how rarely, the terms match the title, the text, the
  // summary and the transcript, so its order stands. It stops at the notes it keeps, so no spare
  // transcript is read.
  const pick = (candidates: Note[]): Note[] => {
    const picked: Note[] = [];
    for (const note of allowed(candidates)) {
      if (picked.length >= maxNotes) break;
      if (hasContent(note)) picked.push(note);
    }
    return picked;
  };
  // A deleted note, or one from a team the user left, can't be read again.
  const readAgain = (noteIds: number[]): Note[] =>
    noteIds.flatMap((noteId) => {
      const note = deps.getNote(noteId);
      return note && !note.deletedAt && note.leftTeam !== 1 ? [note] : [];
    });
  // Only notes whose words match, or that were made in the period the question names, are sent: a
  // question about something else gets no notes rather than unrelated ones.
  const found = readNotes((): FoundNotes => {
    const followUp = query.terms.length === 0 && !query.scope ? findFollowUp(history, now) : null;
    const carried = followUp ? pick(readAgain(followUp.noteIds)) : [];
    if (followUp && carried.length > 0) {
      for (const note of carried) {
        if (!transcripts.has(note.id)) transcripts.set(note.id, deps.getNoteTranscript(note.id));
      }
      return { notes: carried, total: carried.length, period: null, followUp };
    }
    const result = findNotes(
      query,
      (terms, window) => {
        const candidates = deps.getCandidateNotes(terms, {
          includePrivate,
          limit: matchPool,
          window,
        });
        candidates.transcriptMatchIds?.forEach((id) => transcriptMatches.add(id));
        return candidates;
      },
      pick,
    );
    // A note found through what was said in it is sent with those lines, not its summary alone.
    for (const note of result.notes) {
      if (transcriptMatches.has(note.id) && !transcripts.has(note.id)) {
        transcripts.set(note.id, deps.getNoteTranscript(note.id));
      }
    }
    return result;
  });
  const { notes } = found;
  setStep({
    id: 'search',
    status: 'done',
    label: 'Searched your notes',
    detail: describeFound(found),
  });
  throwIfAborted(signal);

  const privateNoteIds = new Set(
    notes.filter((note) => note.isPrivate === 1).map((note) => note.id),
  );
  const buildPayload = (
    payloadNotes: Note[],
    options: { noteCharBudget?: number; history: ChatMessage[] },
  ): Promise<ChatPayload> =>
    buildBudgetedChatPayload(
      {
        question,
        notes: payloadNotes,
        calendar,
        calendarWindowHours,
        now,
        transcripts,
        period: found.period ?? undefined,
        followUp: found.followUp,
        ...options,
      },
      budget,
      signal,
    );

  let payload = await buildPayload(notes, { history });
  throwIfAborted(signal);
  if (payload.sources.length > 0) {
    const reading = describeReading(payload.sources);
    setStep({ id: 'read', status: 'active', label: reading.active });
    setStep({ id: 'read', status: 'done', label: reading.done });
  }

  setStep({ id: 'write', status: 'active', label: 'Writing your answer…' });
  // A failure after an abort reports the abort, so the caller never shows it as an error.
  const send = async (request: ChatPayload): Promise<ReasoningResponse> => {
    const isPrivateNote = request.sources.some((source) => privateNoteIds.has(source.noteId));
    try {
      return await deps.chat({
        systemPrompt: request.systemPrompt,
        text: request.text,
        signal,
        routing: isPrivateNote ? { allowCloudFallback, isPrivateNote } : { allowCloudFallback },
        inferenceRoute,
      });
    } catch (error) {
      throwIfAborted(signal);
      throw error;
    }
  };

  let response: ReasoningResponse;
  try {
    response = await send(payload);
  } catch (error) {
    if (!isLocalContextLimitError(error)) throw error;
    // Token estimates can still miss native overhead. Retry once with a smaller payload;
    // a retry that cuts nothing would fail the same way.
    const retryPayload = await buildPayload(notes.slice(0, 1), {
      noteCharBudget: CONTEXT_LIMIT_NOTE_CHAR_BUDGET,
      history: [],
    });
    throwIfAborted(signal);
    if (retryPayload.text === payload.text) throw error;
    payload = retryPayload;
    // The first payload always reads at least the note the retry keeps, so the read step is
    // already in place before the write step and is relabelled there.
    if (payload.sources.length > 0) {
      const reading = describeReading(payload.sources);
      setStep({ id: 'read', status: 'done', label: reading.done, activeLabel: reading.active });
    } else {
      removeStep('read');
    }
    response = await send(payload);
  }
  throwIfAborted(signal);
  // A reply that was only a <think> block arrives stripped to nothing.
  if (!response.text.trim()) throw new ChatEmptyAnswerError();

  setStep({ id: 'write', status: 'done', label: 'Wrote the answer' });
  return {
    text: response.text,
    steps: [...steps],
    sources: markCitedSources(payload.sources, response.text),
  };
}
