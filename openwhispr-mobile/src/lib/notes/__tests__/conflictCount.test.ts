import { describeConflictCount } from '../conflictCount';

describe('describeConflictCount', () => {
  it('returns null when there is nothing to flag', () => {
    expect(describeConflictCount(0)).toBeNull();
  });

  it('uses the singular form for exactly one conflicted note', () => {
    expect(describeConflictCount(1)).toBe('1 note needs review');
  });

  it('uses the plural form for more than one', () => {
    expect(describeConflictCount(3)).toBe('3 notes need review');
  });
});
