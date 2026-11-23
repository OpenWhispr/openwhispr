/**
 * The full speaker pass after Stop: the whole meeting WAV through the on-device separation
 * (sherpa-onnx Pyannote + TitaNet), then each live line takes the speaker it overlaps most.
 * A line that holds two people for long enough is split at a sentence boundary. Speakers from
 * the pass are matched to the live labels by how much they overlap, so "Speaker 1" stays
 * Speaker 1 and a name given before the pass finished stays on that person.
 */
import { MIN_VOICEPRINT_MS } from './liveSpeakers';

export interface PassLine {
  text: string;
  startMs: number;
  endMs: number;
  label: string | null;
}

export interface PassTurn {
  startMs: number;
  endMs: number;
  speakerId: number | null;
}

export interface PassSegment {
  text: string;
  startMs: number;
  endMs: number;
  speakerLabel: string | null;
}

const overlap = (a: { startMs: number; endMs: number }, b: { startMs: number; endMs: number }) =>
  Math.max(0, Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs));

/** The pass's speakers in time order within one line, short blips folded into a neighbour. */
function runsWithin(line: PassLine, turns: PassTurn[]) {
  const runs: { speakerId: number; startMs: number; endMs: number }[] = [];
  for (const turn of turns) {
    if (turn.speakerId === null) continue;
    const startMs = Math.max(line.startMs, turn.startMs);
    const endMs = Math.min(line.endMs, turn.endMs);
    if (endMs <= startMs) continue;
    const last = runs[runs.length - 1];
    if (last && last.speakerId === turn.speakerId) last.endMs = Math.max(last.endMs, endMs);
    else runs.push({ speakerId: turn.speakerId, startMs, endMs });
  }
  for (let i = 0; i < runs.length && runs.length > 1; ) {
    if (runs[i].endMs - runs[i].startMs >= MIN_VOICEPRINT_MS) {
      i++;
      continue;
    }
    const [removed] = runs.splice(i, 1);
    const neighbour = runs[Math.max(0, i - 1)];
    neighbour.startMs = Math.min(neighbour.startMs, removed.startMs);
    neighbour.endMs = Math.max(neighbour.endMs, removed.endMs);
    // Joining two runs of the same speaker around the blip.
    if (runs[i] && runs[i - 1] && runs[i].speakerId === runs[i - 1].speakerId) {
      runs[i - 1].endMs = runs[i].endMs;
      runs.splice(i, 1);
    }
    i = 0;
  }
  return runs;
}

/** Sentences with the time their middle falls at, spreading the line's time by characters. */
function sentencesOf(line: PassLine) {
  const parts = line.text.match(/[^.!?。！？]+[.!?。！？]+["')\]]*\s*|[^.!?。！？]+$/g) ?? [
    line.text,
  ];
  const total = parts.reduce((sum, part) => sum + part.length, 0) || 1;
  let before = 0;
  return parts.map((part) => {
    const middle =
      line.startMs + ((before + part.length / 2) / total) * (line.endMs - line.startMs);
    const startMs = line.startMs + (before / total) * (line.endMs - line.startMs);
    before += part.length;
    const endMs = line.startMs + (before / total) * (line.endMs - line.startMs);
    return { text: part, middle, startMs, endMs };
  });
}

/** Pass speaker id → label, keeping the live labels where the two agree. */
function mapSpeakers(lines: PassLine[], turns: PassTurn[]): Map<number, string> {
  const shared = new Map<string, number>();
  const used = new Set<string>();
  for (const line of lines) {
    if (!line.label) continue;
    used.add(line.label);
    for (const turn of turns) {
      if (turn.speakerId === null) continue;
      const amount = overlap(line, turn);
      if (!amount) continue;
      const key = `${turn.speakerId}|${line.label}`;
      shared.set(key, (shared.get(key) ?? 0) + amount);
    }
  }
  const mapping = new Map<number, string>();
  const taken = new Set<string>();
  [...shared.entries()]
    .sort((a, b) => b[1] - a[1])
    .forEach(([key]) => {
      const [id, label] = [Number(key.slice(0, key.indexOf('|'))), key.slice(key.indexOf('|') + 1)];
      if (mapping.has(id) || taken.has(label)) return;
      mapping.set(id, label);
      taken.add(label);
    });
  let next =
    Math.max(
      -1,
      ...[...used].map((label) => Number(label.replace('speaker_', ''))).filter(Number.isFinite),
    ) + 1;
  for (const turn of turns) {
    if (turn.speakerId === null || mapping.has(turn.speakerId)) continue;
    mapping.set(turn.speakerId, `speaker_${next++}`);
  }
  return mapping;
}

export function applySpeakerPass(lines: PassLine[], turns: PassTurn[]): PassSegment[] {
  const sorted = [...turns].sort((a, b) => a.startMs - b.startMs);
  const mapping = mapSpeakers(lines, sorted);
  const segments: PassSegment[] = [];
  for (const line of lines) {
    const runs = runsWithin(line, sorted);
    if (runs.length === 0) {
      segments.push({ ...line, speakerLabel: line.label });
      continue;
    }
    const sentences = runs.length > 1 ? sentencesOf(line) : [];
    if (sentences.length > 1) {
      const pieces: PassSegment[] = [];
      for (const sentence of sentences) {
        const run =
          runs.find((item) => sentence.middle >= item.startMs && sentence.middle < item.endMs) ??
          runs.reduce((best, item) =>
            Math.abs((item.startMs + item.endMs) / 2 - sentence.middle) <
            Math.abs((best.startMs + best.endMs) / 2 - sentence.middle)
              ? item
              : best,
          );
        const label = mapping.get(run.speakerId) ?? null;
        const last = pieces[pieces.length - 1];
        if (last && last.speakerLabel === label) {
          last.text += sentence.text;
          last.endMs = Math.round(sentence.endMs);
        } else
          pieces.push({
            text: sentence.text,
            startMs: Math.round(sentence.startMs),
            endMs: Math.round(sentence.endMs),
            speakerLabel: label,
          });
      }
      for (const piece of pieces) segments.push({ ...piece, text: piece.text.trim() });
      continue;
    }
    const main = runs.reduce((best, run) =>
      run.endMs - run.startMs > best.endMs - best.startMs ? run : best,
    );
    segments.push({ ...line, speakerLabel: mapping.get(main.speakerId) ?? line.label });
  }
  return segments;
}
