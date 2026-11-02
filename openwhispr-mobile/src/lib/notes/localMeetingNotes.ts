import { AppleLLM } from '@/lib/appleLLM';
import { notesRepository } from '@/data';
import type { Note, Segment, Speaker } from '@/data/types';
import {
  countLocalInputTokens,
  fitsLocalReasoningBudget,
  getLocalInputTokenBudget,
  getLocalReasoningReadiness,
  isLocalContextLimitError,
  isLocalOutputLimitError,
  LOCAL_OUTPUT_TOKEN_RESERVE,
  toLocalReasoningError,
} from '@/lib/localReasoning';
import { formatTranscriptForExport } from '@/lib/diarization/transcriptDisplay';
import { parseCalendarParticipants } from '@/lib/calendar/meetingContext';
import { buildMeetingNotesInput, type MeetingNotesContext } from '@/lib/notes/meetingNotesInput';
import {
  buildActionSystemPrompt,
  isDefaultGenerateNotesAction,
} from '@/lib/notes/generateNotesPrompt';
import type { StructuredMeetingNotes } from '@/types';

const DEFAULT_LOCAL_MEETING_ACTION_PROMPT =
  'Transform this meeting transcript into concise, actionable meeting notes.';

// Each chunk's notes have to fit LOCAL_OUTPUT_TOKEN_RESERVE, the maximumResponseTokens these runs
// pass, which a larger context (iOS 27's 8,192) doesn't grow. Chunks the size of iOS 26's whole
// input budget already ran past it. Notes grow with the transcript they cover, so the limit is on
// transcript, not on the instructions and raw notes every chunk repeats; with the default
// instructions, a full chunk is about 2,000 tokens.
const LOCAL_MEETING_CHUNK_MAX_TRANSCRIPT_TOKENS = 1_300;

// A chunk whose notes still run past the cap is halved, and each half can be halved again, at most
// this many times in a row: up to 7 runs for one chunk, so a model that keeps looping can't turn it
// into dozens of slow runs. A piece that still overflows fails the note.
const MAX_OUTPUT_LIMIT_SPLITS = 2;

// Merged notes have to fit LOCAL_OUTPUT_TOKEN_RESERVE too, so a merge reads at most iOS 26's whole
// input budget (4,096 - 900 - 300), the size merges run at there, however large the context. A
// bigger merge is more likely to run to the cap, a full slow run before the hand merge.
const LOCAL_MEETING_MERGE_MAX_INPUT_TOKENS = 2_896;

const emptyMeetingNotes = (): StructuredMeetingNotes => ({
  summary: '',
  keyDiscussionPoints: [],
  decisions: [],
  actionItems: [],
  followUps: [],
});

const normalizeItems = (items: string[] | undefined): string[] =>
  (items ?? []).map((item) => item.trim()).filter(Boolean);

const normalizeMeetingNotes = (notes: StructuredMeetingNotes): StructuredMeetingNotes => ({
  summary: notes.summary?.trim() ?? '',
  keyDiscussionPoints: normalizeItems(notes.keyDiscussionPoints),
  decisions: normalizeItems(notes.decisions),
  actionItems: (notes.actionItems ?? [])
    .map((item) => ({
      text: item.text?.trim() ?? '',
      owner: item.owner?.trim() || null,
    }))
    .filter((item) => item.text),
  followUps: normalizeItems(notes.followUps),
});

function dedupeStrings(items: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const item of items) {
    const key = item.trim().toLocaleLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(item.trim());
  }
  return deduped;
}

export function mergeStructuredMeetingNotes(
  notes: StructuredMeetingNotes[],
): StructuredMeetingNotes {
  const normalized = notes.map(normalizeMeetingNotes);
  return {
    summary: normalized
      .map((note) => note.summary)
      .filter(Boolean)
      .join(' '),
    keyDiscussionPoints: dedupeStrings(normalized.flatMap((note) => note.keyDiscussionPoints)),
    decisions: dedupeStrings(normalized.flatMap((note) => note.decisions)),
    actionItems: normalized.flatMap((note) => note.actionItems),
    followUps: dedupeStrings(normalized.flatMap((note) => note.followUps)),
  };
}

function renderSection(title: string, items: string[]): string {
  if (items.length === 0) return '';
  return [`## ${title}`, items.map((item) => `- ${item}`).join('\n')].join('\n');
}

export function renderStructuredMeetingNotesToMarkdown(notes: StructuredMeetingNotes): string {
  const normalized = normalizeMeetingNotes(notes);
  const actionItems = normalized.actionItems.map((item) => {
    const owner = item.owner ? `${item.owner}: ` : '';
    return `- [ ] ${owner}${item.text}`;
  });

  return [
    normalized.summary,
    renderSection('Key Discussion Points', normalized.keyDiscussionPoints),
    renderSection('Decisions Made', normalized.decisions),
    actionItems.length > 0 ? ['## Action Items', actionItems.join('\n')].join('\n') : '',
    renderSection('Follow-ups', normalized.followUps),
  ]
    .map((section) => section.trim())
    .filter(Boolean)
    .join('\n\n');
}

function resolveMeetingContext(note: Note): MeetingNotesContext | undefined {
  if (!note.calendarEventId) return undefined;
  return {
    eventTitle: note.title,
    participants: parseCalendarParticipants(note.participants ?? null) ?? [],
  };
}

function transcriptLines(segments: Segment[], speakers: Speaker[]): string[] {
  return formatTranscriptForExport({
    segments,
    speakers,
    suppressUnlabeledSpeakerNames: true,
  })
    .split(/\n{2,}/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function buildChunkInput(input: {
  note: Note;
  lines: string[];
  meetingContext?: MeetingNotesContext;
}): string {
  return buildMeetingNotesInput({
    rawNotes: input.note.content,
    transcript: input.lines.join('\n\n'),
    meetingContext: input.meetingContext,
  });
}

async function buildTranscriptChunks(input: {
  note: Note;
  lines: string[];
  meetingContext?: MeetingNotesContext;
  instructions: string;
  budget: number;
  overhead: number;
}): Promise<string[][]> {
  const chunks: string[][] = [];
  let current: string[] = [];
  const pending = [...input.lines];

  for (let line = pending.shift(); line !== undefined; line = pending.shift()) {
    const candidate = [...current, line];
    const prompt = buildChunkInput({
      note: input.note,
      lines: candidate,
      meetingContext: input.meetingContext,
    });
    const fits = await fitsLocalReasoningBudget({
      instructions: input.instructions,
      prompt,
      budget: input.budget,
    });

    if (fits) {
      current = candidate;
    } else if (current.length > 0) {
      chunks.push(current);
      current = [];
      pending.unshift(line);
    } else {
      // One speaker's consecutive segments are one line, so a long stretch by one speaker can
      // outgrow a chunk by itself. It is split by words; a single word is kept as it is, and so is
      // every line when the instructions and raw notes alone fill a chunk.
      const halves = input.overhead < input.budget ? splitTranscriptLine(line) : null;
      if (halves) pending.unshift(...halves);
      else current = [line];
    }
  }

  if (current.length > 0) chunks.push(current);
  return chunks;
}

function splitTranscriptLine(line: string): [string, string] | null {
  const match =
    line.match(/^(\[[^\]]+\]\s+[^:]+:\s*)([\s\S]+)$/) ?? line.match(/^(\[[^\]]+\]\s*)([\s\S]+)$/);
  const prefix = match?.[1] ?? '';
  const text = (match?.[2] ?? line).trim();
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < 2) return null;
  const midpoint = Math.ceil(words.length / 2);
  return [
    `${prefix}${words.slice(0, midpoint).join(' ')}`.trim(),
    `${prefix}${words.slice(midpoint).join(' ')}`.trim(),
  ];
}

async function generateStructuredNotes(input: {
  instructions: string;
  prompt: string;
}): Promise<StructuredMeetingNotes> {
  try {
    const notes = await AppleLLM.generateMeetingNotes({
      instructions: input.instructions,
      prompt: input.prompt,
      temperature: 0.2,
      maxTokens: LOCAL_OUTPUT_TOKEN_RESERVE,
    });
    return normalizeMeetingNotes(notes);
  } catch (error) {
    throw toLocalReasoningError(error);
  }
}

function buildMapPrompt(input: { chunkInput: string; previousSummary?: string }): string {
  return [
    input.previousSummary
      ? `Previous chunk summary for continuity:\n${input.previousSummary.trim()}`
      : '',
    input.chunkInput,
    'Return only the important summary, discussion points, decisions, action items, and follow-ups supported by this chunk.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

async function mapChunkWithRetry(input: {
  note: Note;
  lines: string[];
  meetingContext?: MeetingNotesContext;
  instructions: string;
  previousSummary?: string;
  outputLimitSplitsLeft?: number;
}): Promise<StructuredMeetingNotes[]> {
  const outputLimitSplitsLeft = input.outputLimitSplitsLeft ?? MAX_OUTPUT_LIMIT_SPLITS;
  const chunkInput = buildChunkInput({
    note: input.note,
    lines: input.lines,
    meetingContext: input.meetingContext,
  });

  try {
    return [
      await generateStructuredNotes({
        instructions: input.instructions,
        prompt: buildMapPrompt({
          chunkInput,
          previousSummary: input.previousSummary,
        }),
      }),
    ];
  } catch (error) {
    const outputLimit = isLocalOutputLimitError(error);
    if (!isLocalContextLimitError(error) && !(outputLimit && outputLimitSplitsLeft > 0)) {
      throw error;
    }

    // Notes too long for the output cap come from too much material, so fewer lines fix them.
    // Chunking already split any line longer than a chunk's transcript limit, so one line's notes
    // overflowing means the model is looping, and half a line won't help.
    const split =
      input.lines.length > 1
        ? [
            input.lines.slice(0, Math.ceil(input.lines.length / 2)),
            input.lines.slice(Math.ceil(input.lines.length / 2)),
          ]
        : outputLimit
          ? null
          : splitTranscriptLine(input.lines[0])?.map((line) => [line]);

    if (!split) throw error;

    const next = {
      ...input,
      outputLimitSplitsLeft: outputLimit ? outputLimitSplitsLeft - 1 : outputLimitSplitsLeft,
    };
    const left = await mapChunkWithRetry({
      ...next,
      lines: split[0],
    });
    const nextSummary = left[left.length - 1]?.summary || input.previousSummary;
    const right = await mapChunkWithRetry({
      ...next,
      lines: split[1],
      previousSummary: nextSummary,
    });
    return [...left, ...right];
  }
}

function buildReducePrompt(notes: StructuredMeetingNotes[]): string {
  return [
    'Merge these partial structured meeting notes into one coherent set. Deduplicate repeated points and preserve concrete decisions and action items.',
    JSON.stringify(notes.map(normalizeMeetingNotes), null, 2),
  ].join('\n\n');
}

async function reduceStructuredNotes(input: {
  notes: StructuredMeetingNotes[];
  instructions: string;
  budget: number;
}): Promise<StructuredMeetingNotes> {
  if (input.notes.length === 0) return emptyMeetingNotes();
  if (input.notes.length === 1) return normalizeMeetingNotes(input.notes[0]);

  const prompt = buildReducePrompt(input.notes);
  if (
    await fitsLocalReasoningBudget({
      instructions: input.instructions,
      prompt,
      budget: input.budget,
    })
  ) {
    try {
      return await generateStructuredNotes({
        instructions: input.instructions,
        prompt,
      });
    } catch (error) {
      // Merged notes too long for the output cap are merged like ones too long to read.
      if (!isLocalOutputLimitError(error)) throw error;
    }
  }

  if (input.notes.length === 2) {
    return mergeStructuredMeetingNotes(input.notes);
  }

  const midpoint = Math.ceil(input.notes.length / 2);
  const left = await reduceStructuredNotes({
    ...input,
    notes: input.notes.slice(0, midpoint),
  });
  const right = await reduceStructuredNotes({
    ...input,
    notes: input.notes.slice(midpoint),
  });
  return reduceStructuredNotes({
    ...input,
    notes: [left, right],
  });
}

export async function generateLocalMeetingNotes(
  noteId: number,
  options: { actionPrompt?: string } = {},
): Promise<string> {
  const note = notesRepository.getNoteById(noteId);
  if (!note || note.deletedAt || note.noteType !== 'meeting') return '';

  const segments = notesRepository.getSegments(noteId);
  if (segments.length === 0) return '';

  const startedAt = Date.now();
  const actionPrompt =
    options.actionPrompt ??
    notesRepository.getActions().find(isDefaultGenerateNotesAction)?.prompt ??
    DEFAULT_LOCAL_MEETING_ACTION_PROMPT;
  const instructions = buildActionSystemPrompt({
    actionPrompt,
    inputKind: 'meeting-transcript',
    isDefaultGenerateNotesAction: true,
  });
  const readiness = await getLocalReasoningReadiness();
  const budget = getLocalInputTokenBudget(readiness);
  const meetingContext = resolveMeetingContext(note);
  const chunkOverhead = await countLocalInputTokens({
    instructions,
    prompt: buildChunkInput({ note, lines: [], meetingContext }),
  });
  const chunkBudget = Math.min(budget, chunkOverhead + LOCAL_MEETING_CHUNK_MAX_TRANSCRIPT_TOKENS);
  const lines = transcriptLines(segments, notesRepository.getSpeakers(noteId));
  const chunks = await buildTranscriptChunks({
    note,
    lines,
    meetingContext,
    instructions,
    budget: chunkBudget,
    overhead: chunkOverhead,
  });

  const mapped: StructuredMeetingNotes[] = [];
  for (const linesInChunk of chunks) {
    const previousSummary = mapped[mapped.length - 1]?.summary;
    mapped.push(
      ...(await mapChunkWithRetry({
        note,
        lines: linesInChunk,
        meetingContext,
        instructions,
        previousSummary,
      })),
    );
  }

  const reduced = await reduceStructuredNotes({
    notes: mapped,
    instructions,
    budget: Math.min(budget, LOCAL_MEETING_MERGE_MAX_INPUT_TOKENS),
  });
  const markdown = renderStructuredMeetingNotesToMarkdown(reduced);

  if (__DEV__) {
    console.log(
      `[reasoning] provider=local model=apple-fm mode=meeting chunks=${chunks.length} elapsedMs=${Date.now() - startedAt}`,
    );
  }

  return markdown;
}
