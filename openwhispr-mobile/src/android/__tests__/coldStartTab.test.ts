import { readFileSync } from 'fs';
import { join } from 'path';

// A cold start redirects to /(tabs)/(record), whose path is "/". An initialRouteName on a tab's own
// stack makes that tab's index win "/" instead, and the app opened on Notes (A73, 27 Nov). Home's
// upload opens the Notes tab before the note rather than anchoring the Notes stack.
const TAB_STACKS = ['(notes)', '(record)', '(dictionary)', '(style)'];

describe('cold start lands on Home', () => {
  it.each(TAB_STACKS)('the %s stack sets no initialRouteName', (tab) => {
    const layout = readFileSync(
      join(__dirname, '../../../app-android/(tabs)', tab, '_layout.tsx'),
      'utf8',
    );
    expect(layout).not.toMatch(/export const unstable_settings/);
  });

  it('the tabs open on Home', () => {
    const layout = readFileSync(join(__dirname, '../../../app-android/(tabs)/_layout.tsx'), 'utf8');
    expect(layout).toMatch(/initialRouteName:\s*'\(record\)'/);
  });
});
