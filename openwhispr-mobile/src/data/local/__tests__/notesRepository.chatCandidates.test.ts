import { eq } from 'drizzle-orm';
import { notes, transcriptSegments } from '@/db/schema';
import { createMemoryRepository, type TestDb } from './testDb';

type SeedNote = {
  title?: string;
  content?: string;
  enhancedContent?: string | null;
  transcript?: string | null;
  isPrivate?: number;
  leftTeam?: number;
  deletedAt?: string | null;
  noteType?: string;
  createdAt?: string;
  updatedAt: string;
};

const seed = (
  repo: ReturnType<typeof createMemoryRepository>['repo'],
  db: TestDb,
  { updatedAt, ...fields }: SeedNote,
): number => {
  const note = repo.createNote(fields.title ?? 'Untitled', fields.content ?? '');
  db.update(notes)
    .set({ ...fields, updatedAt })
    .where(eq(notes.id, note.id))
    .run();
  return note.id;
};

describe('LocalNotesRepository.getChatCandidateNotes', () => {
  it('matches a term in the AI summary', () => {
    const { repo, db } = createMemoryRepository();
    const id = seed(repo, db, {
      title: 'Budget sync',
      content: 'plain content',
      enhancedContent: 'Team stays at $12',
      updatedAt: '2026-10-01 10:00:00',
    });
    seed(repo, db, { title: 'Other', content: 'nothing', updatedAt: '2026-10-02 10:00:00' });

    const result = repo.getChatCandidateNotes(['$12'], { includePrivate: false, limit: 10 }).notes;

    expect(result.map((note) => note.id)).toEqual([id]);
  });

  it('matches a term in the transcript segments', () => {
    const { repo, db } = createMemoryRepository();
    // A note created first gives the segments ids that differ from their note's id.
    seed(repo, db, { title: 'Other', updatedAt: '2026-10-01 09:00:00' });
    const id = repo.createNote('Weekly sync', '').id;
    repo.replaceSegments(id, [
      { noteId: id, startMs: 0, endMs: 1000, text: 'hello everyone' },
      { noteId: id, startMs: 1000, endMs: 2000, text: 'we agreed on the roadmap' },
    ]);

    const result = repo.getChatCandidateNotes(['roadmap'], {
      includePrivate: false,
      limit: 10,
    }).notes;

    expect(result.map((note) => note.id)).toEqual([id]);
  });

  it('never matches the keys of the transcript JSON', () => {
    const { repo, db } = createMemoryRepository();
    seed(repo, db, {
      title: 'Weekly sync',
      transcript: JSON.stringify([{ source: 'system', text: 'hi', speakerLockSource: 'user' }]),
      updatedAt: '2026-10-01 10:00:00',
    });

    for (const term of ['source', 'system', 'text', 'user']) {
      expect(
        repo.getChatCandidateNotes([term], { includePrivate: false, limit: 10 }).notes,
      ).toEqual([]);
    }
  });

  it('ignores deleted transcript segments', () => {
    const { repo, db } = createMemoryRepository();
    const id = repo.createNote('Weekly sync', '').id;
    repo.replaceSegments(id, [{ noteId: id, startMs: 0, endMs: 1000, text: 'roadmap' }]);
    db.update(transcriptSegments).set({ deletedAt: '2026-10-01 10:00:00' }).run();

    expect(
      repo.getChatCandidateNotes(['roadmap'], { includePrivate: false, limit: 10 }).notes,
    ).toEqual([]);
  });

  it('keeps the notes matching the most terms when the pool is cut', () => {
    const { repo, db } = createMemoryRepository();
    const acme = seed(repo, db, {
      title: 'Acme kickoff',
      content: 'Kickoff with Acme on the 4th.',
      updatedAt: '2026-09-01 10:00:00',
    });
    const bodyOnly = seed(repo, db, {
      content: 'acme and kickoff both mentioned',
      updatedAt: '2026-09-02 10:00:00',
    });
    for (let day = 10; day < 20; day += 1) {
      seed(repo, db, { content: 'another kickoff', updatedAt: `2026-10-${day} 10:00:00` });
    }

    const result = repo.getChatCandidateNotes(['acme', 'kickoff'], {
      includePrivate: false,
      limit: 2,
    }).notes;

    expect(result.map((note) => note.id)).toEqual([acme, bodyOnly]);
  });

  it('ranks a meeting matching every term in its transcript above newer single matches', () => {
    const { repo, db } = createMemoryRepository();
    const meeting = seed(repo, db, { title: 'Leadership sync', updatedAt: '2026-09-01 10:00:00' });
    repo.replaceSegments(meeting, [
      { noteId: meeting, startMs: 0, endMs: 1000, text: 'The hiring freeze holds.' },
    ]);
    for (let day = 10; day < 14; day += 1) {
      seed(repo, db, { content: 'A hiring update.', updatedAt: `2026-10-${day} 10:00:00` });
    }

    const result = repo.getChatCandidateNotes(['hiring', 'freeze'], {
      includePrivate: false,
      limit: 4,
    }).notes;

    expect(result[0].id).toBe(meeting);
    expect(result).toHaveLength(4);
  });

  it('treats % and _ in a term literally', () => {
    const { repo, db } = createMemoryRepository();
    const id = seed(repo, db, { content: 'grew 50% this year', updatedAt: '2026-10-01 10:00:00' });
    seed(repo, db, { content: 'grew 500 this year', updatedAt: '2026-10-02 10:00:00' });

    const result = repo.getChatCandidateNotes(['50%'], { includePrivate: false, limit: 10 }).notes;

    expect(result.map((note) => note.id)).toEqual([id]);
  });

  it('excludes private notes unless asked', () => {
    const { repo, db } = createMemoryRepository();
    const id = seed(repo, db, {
      content: 'secret plan',
      isPrivate: 1,
      updatedAt: '2026-10-01 10:00:00',
    });

    expect(
      repo.getChatCandidateNotes(['secret'], { includePrivate: false, limit: 10 }).notes,
    ).toEqual([]);
    expect(
      repo
        .getChatCandidateNotes(['secret'], { includePrivate: true, limit: 10 })
        .notes.map((n) => n.id),
    ).toEqual([id]);
  });

  it('excludes deleted and left-team notes', () => {
    const { repo, db } = createMemoryRepository();
    seed(repo, db, {
      content: 'match deleted',
      deletedAt: '2026-10-01 09:00:00',
      updatedAt: '2026-10-01 10:00:00',
    });
    seed(repo, db, { content: 'match left', leftTeam: 1, updatedAt: '2026-10-01 11:00:00' });
    const keptId = seed(repo, db, { content: 'match kept', updatedAt: '2026-10-01 12:00:00' });

    const result = repo.getChatCandidateNotes(['match'], { includePrivate: true, limit: 10 }).notes;

    expect(result.map((note) => note.id)).toEqual([keptId]);
  });

  it('orders equal matches by most recently updated and caps at the limit', () => {
    const { repo, db } = createMemoryRepository();
    seed(repo, db, { content: 'alpha old', updatedAt: '2026-10-01 10:00:00' });
    const newest = seed(repo, db, { content: 'alpha new', updatedAt: '2026-10-03 10:00:00' });
    const middle = seed(repo, db, { content: 'alpha mid', updatedAt: '2026-10-02 10:00:00' });

    const result = repo.getChatCandidateNotes(['alpha'], { includePrivate: false, limit: 2 });

    expect(result.notes.map((note) => note.id)).toEqual([newest, middle]);
    // The step detail says how many notes matched, not how many were kept.
    expect(result.total).toBe(3);
  });

  it('matches a short Latin term as a whole word only', () => {
    const { repo, db } = createMemoryRepository();
    const ai = seed(repo, db, { content: 'Our AI plan.', updatedAt: '2026-10-01 10:00:00' });
    const q3 = seed(repo, db, { title: 'Q3', updatedAt: '2026-10-02 10:00:00' });
    const ten = seed(repo, db, { content: 'Ship 10 seats', updatedAt: '2026-10-03 10:00:00' });
    seed(repo, db, {
      content: 'She said to email Q30 in 2010, 100 times',
      updatedAt: '2026-10-04 10:00:00',
    });

    const ids = (term: string): number[] =>
      repo
        .getChatCandidateNotes([term], { includePrivate: false, limit: 10 })
        .notes.map((note) => note.id);

    expect(ids('ai')).toEqual([ai]);
    expect(ids('q3')).toEqual([q3]);
    expect(ids('10')).toEqual([ten]);
  });

  it('matches a number only as a whole number', () => {
    const { repo, db } = createMemoryRepository();
    const plain = seed(repo, db, { content: 'We need 10.', updatedAt: '2026-10-01 10:00:00' });
    const listed = seed(repo, db, { content: 'Seats: 10, 12', updatedAt: '2026-10-02 10:00:00' });
    const dated = seed(repo, db, { content: 'Planned for 2026', updatedAt: '2026-10-03 10:00:00' });
    seed(repo, db, {
      content: 'Starts 10:30, ships 1.10 in 20261, costs 100 or 10,000',
      updatedAt: '2026-10-04 10:00:00',
    });

    const ids = (term: string): number[] =>
      repo
        .getChatCandidateNotes([term], { includePrivate: false, limit: 10 })
        .notes.map((note) => note.id);

    expect(ids('10')).toEqual([listed, plain]);
    expect(ids('2026')).toEqual([dated]);
  });

  it('matches a number with "." "," or ":" in it whole', () => {
    const { repo, db } = createMemoryRepository();
    const version = seed(repo, db, { content: 'Ships in 1.10.', updatedAt: '2026-10-01 10:00:00' });
    const amount = seed(repo, db, { content: 'Owes $10,000', updatedAt: '2026-10-02 10:00:00' });
    seed(repo, db, {
      content: 'Not 1.100, 11.10, 1.10.2, v1.10 or 10,000,000',
      updatedAt: '2026-10-03 10:00:00',
    });

    const ids = (term: string): number[] =>
      repo
        .getChatCandidateNotes([term], { includePrivate: false, limit: 10 })
        .notes.map((note) => note.id);

    expect(ids('1.10')).toEqual([version]);
    expect(ids('10,000')).toEqual([amount]);
  });

  it('matches a Korean term inside a longer word', () => {
    const { repo, db } = createMemoryRepository();
    const id = seed(repo, db, {
      content: '예산 회의록을 공유했어요',
      updatedAt: '2026-10-01 10:00:00',
    });

    expect(
      repo
        .getChatCandidateNotes(['회의'], { includePrivate: false, limit: 10 })
        .notes.map((note) => note.id),
    ).toEqual([id]);
  });

  it('matches a non-ASCII term capitalised in the note', () => {
    const { repo, db } = createMemoryRepository();
    const id = seed(repo, db, { title: 'Übergabe Projekt', updatedAt: '2026-10-01 10:00:00' });

    const result = repo.getChatCandidateNotes(['übergabe', 'status'], {
      includePrivate: false,
      limit: 10,
    });

    expect(result.notes.map((note) => note.id)).toEqual([id]);
  });

  it('returns recent notes when there are no terms', () => {
    const { repo, db } = createMemoryRepository();
    seed(repo, db, { content: 'oldest', updatedAt: '2026-10-01 10:00:00' });
    const newest = seed(repo, db, { content: 'newest', updatedAt: '2026-10-03 10:00:00' });
    const middle = seed(repo, db, { content: 'middle', updatedAt: '2026-10-02 10:00:00' });
    seed(repo, db, { content: 'gone', leftTeam: 1, updatedAt: '2026-10-04 10:00:00' });

    const result = repo.getChatCandidateNotes([], { includePrivate: false, limit: 2 }).notes;

    expect(result.map((note) => note.id)).toEqual([newest, middle]);
  });

  describe('in a period', () => {
    const window = {
      start: new Date('2026-10-19T00:00:00Z'),
      end: new Date('2026-10-23T00:00:00Z'),
      meetingsOnly: false,
    };

    it('keeps only the notes made in it that match, or with no terms all of them, newest first', () => {
      const { repo, db } = createMemoryRepository();
      const early = seed(repo, db, {
        content: 'Pricing holds.',
        createdAt: '2026-10-19 09:00:00',
        updatedAt: '2026-10-19 09:00:00',
      });
      // The server's ISO timestamps compare as instants alongside SQLite's own.
      const late = seed(repo, db, {
        content: 'Hiring update.',
        createdAt: '2026-10-22T08:00:00.000Z',
        updatedAt: '2026-10-22 08:00:00',
      });
      const middle = seed(repo, db, {
        content: 'Roadmap review.',
        createdAt: '2026-10-21T10:00:00+02:00',
        updatedAt: '2026-10-21 08:00:00',
      });
      // Edited this week, but made before it.
      seed(repo, db, {
        content: 'Pricing call.',
        createdAt: '2026-10-18 23:59:59',
        updatedAt: '2026-10-22 09:00:00',
      });
      seed(repo, db, {
        content: 'Pricing tomorrow.',
        createdAt: '2026-10-23 00:00:00',
        updatedAt: '2026-10-23 00:00:00',
      });

      const matched = repo.getChatCandidateNotes(['pricing'], {
        includePrivate: false,
        limit: 10,
        window,
      });
      const unmatched = repo.getChatCandidateNotes(['budget'], {
        includePrivate: false,
        limit: 10,
        window,
      });
      const noTerms = repo.getChatCandidateNotes([], { includePrivate: false, limit: 2, window });

      expect(matched.notes.map((note) => note.id)).toEqual([early]);
      expect(matched.total).toBe(1);
      expect(unmatched).toEqual({ notes: [], total: 0 });
      expect(noTerms.notes.map((note) => note.id)).toEqual([late, middle]);
      expect(noTerms.total).toBe(3);
    });

    it('keeps only meetings when asked, and still hides private, deleted and left notes', () => {
      const { repo, db } = createMemoryRepository();
      const createdAt = '2026-10-20 10:00:00';
      const meeting = seed(repo, db, {
        title: 'Standup',
        noteType: 'meeting',
        createdAt,
        updatedAt: createdAt,
      });
      seed(repo, db, { title: 'Groceries', createdAt, updatedAt: createdAt });
      seed(repo, db, { noteType: 'meeting', isPrivate: 1, createdAt, updatedAt: createdAt });
      seed(repo, db, { noteType: 'meeting', leftTeam: 1, createdAt, updatedAt: createdAt });
      seed(repo, db, {
        noteType: 'meeting',
        deletedAt: createdAt,
        createdAt,
        updatedAt: createdAt,
      });

      const result = repo.getChatCandidateNotes([], {
        includePrivate: false,
        limit: 10,
        window: { ...window, meetingsOnly: true },
      });

      expect(result.notes.map((note) => note.id)).toEqual([meeting]);
      expect(result.total).toBe(1);
    });
  });
});
