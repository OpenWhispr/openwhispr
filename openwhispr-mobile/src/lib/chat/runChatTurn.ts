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
import type { ReasoningResponse, ReasoningRoutingOptions } from '@/types';
import {
  buildChatPayload,
  countPeriodNotes,
  formatChatTime,
  isInChatCalendarWindow,
  lacksNoteText,
  parseChatQuery,
  type ChatCalendar,
  type ChatNotesPeriod,
  type ChatPayload,
  type ChatQuery,
  type ChatTimeScope,
} from './chatContext';
import type { ChatMessage, ChatSource, ChatStep, ChatStepId } from './types';

const MAX_MATCHED_NOTES = 4;
// A note found can be empty (a failed recording matching by title, or made in the period asked
// about), so a few spares are read to take its place.
const MATCH_POOL = MAX_MATCHED_NOTES * 2;
const NO_NOTES: ChatCandidateNotes = { notes: [], total: 0 };
const CONTEXT_LIMIT_NOTE_CHAR_BUDGET = 3_000;
// The read spans the day looked back as well as the 48 hours sent, so 72 hours share it: about 16
// events a day, more than a busy calendar holds, so tomorrow isn't pushed out of the request.
const CHAT_CALENDAR_EVENT_LIMIT = 50;
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
  isNotePrivate: (noteId) => {
    const { notesRepository } = require('@/data') as typeof import('@/data');
    // A note that can't be found may have been private when it was deleted, so it counts as private.
    const note = notesRepository.getNoteById(noteId);
    return note == null || note.isPrivate === 1;
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
      CHAT_CALENDAR_EVENT_LIMIT,
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

const throwIfAborted = (signal: AbortSignal): void => {
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
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

const describeNextEvent = (events: GoogleCalendarEvent[], now: Date): string => {
  const next = events.find((event) => isInChatCalendarWindow(event, now));
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
}

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

const describeFound = ({ total, period }: FoundNotes): string => {
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
    if (index === -1) steps.push(step);
    else steps[index] = step;
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
  const includePrivate = selection?.mode === 'local';
  // The repository already filters private notes; this keeps them out whatever it returns.
  const allowed = (notes: Note[]): Note[] =>
    includePrivate ? notes : notes.filter((note) => note.isPrivate !== 1);
  const history =
    includePrivate || !usedPrivateNote(input.history, deps.isNotePrivate) ? input.history : [];

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
        detail: describeNextEvent(events, now),
      });
    }
    throwIfAborted(signal);
  }

  setStep({ id: 'search', status: 'active', label: 'Searching your notes…' });
  // Transcripts of the notes with no text of their own, read once whether a note is sent or passed
  // over for having nothing in it.
  const transcripts = new Map<number, string>();
  const hasContent = (note: Note): boolean => {
    if (!lacksNoteText(note)) return true;
    const transcript = transcripts.get(note.id) ?? deps.getNoteTranscript(note.id);
    transcripts.set(note.id, transcript);
    return transcript.trim() !== '';
  };
  // The repository ranks by matched terms across the title, the text, the summary and the
  // transcript, so its order stands. It stops at the notes it keeps, so no spare transcript is read.
  const pick = (candidates: Note[]): Note[] => {
    const picked: Note[] = [];
    for (const note of allowed(candidates)) {
      if (picked.length >= MAX_MATCHED_NOTES) break;
      if (hasContent(note)) picked.push(note);
    }
    return picked;
  };
  // Only notes whose words match, or that were made in the period the question names, are sent: a
  // question about something else gets no notes rather than unrelated ones.
  const found = findNotes(
    parseChatQuery(question, now),
    (terms, window) => deps.getCandidateNotes(terms, { includePrivate, limit: MATCH_POOL, window }),
    pick,
  );
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
  ): ChatPayload =>
    buildChatPayload({
      question,
      notes: payloadNotes,
      calendar,
      now,
      transcripts,
      period: found.period ?? undefined,
      ...options,
    });

  let payload = buildPayload(notes, { history });
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
    // History is uncapped in length, so a long chat would overflow on every retry. A retry that
    // cuts nothing would fail the same way.
    const retryPayload = buildPayload(notes.slice(0, 1), {
      noteCharBudget: CONTEXT_LIMIT_NOTE_CHAR_BUDGET,
      history: [],
    });
    if (retryPayload.text === payload.text) throw error;
    payload = retryPayload;
    // The first payload always reads at least the note the retry keeps, so the read step is
    // already in place before the write step and is relabelled there.
    if (payload.sources.length > 0) {
      setStep({ id: 'read', status: 'done', label: describeReading(payload.sources).done });
    } else {
      removeStep('read');
    }
    response = await send(payload);
  }
  throwIfAborted(signal);

  setStep({ id: 'write', status: 'done', label: 'Wrote the answer' });
  return { text: response.text, steps: [...steps], sources: payload.sources };
}
