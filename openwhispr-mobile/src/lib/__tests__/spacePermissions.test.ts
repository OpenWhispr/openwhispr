import { canMoveBetweenSpaces } from '../spacePermissions';

const privateSpace = { kind: 'private' as const, workspaceId: null };
const teamSpace = (workspaceId: string | null = 'workspace-1') => ({
  kind: 'team' as const,
  workspaceId,
});

// Mirrors desktop's canMoveBetweenSpaces so the two clients agree on where a
// note is allowed to go.
describe('canMoveBetweenSpaces', () => {
  it('lets personal content move into any team space', () => {
    expect(canMoveBetweenSpaces(privateSpace, teamSpace())).toBe(true);
    expect(canMoveBetweenSpaces(privateSpace, teamSpace('workspace-2'))).toBe(true);
  });

  it('never lets team content move back to the private space', () => {
    expect(canMoveBetweenSpaces(teamSpace(), privateSpace)).toBe(false);
  });

  it('lets team content move within its own workspace', () => {
    expect(canMoveBetweenSpaces(teamSpace('workspace-1'), teamSpace('workspace-1'))).toBe(true);
  });

  it('never lets team content cross into another workspace', () => {
    expect(canMoveBetweenSpaces(teamSpace('workspace-1'), teamSpace('workspace-2'))).toBe(false);
  });

  // A skeleton space mirrored before its backfill completed has no workspace id,
  // so nothing may move out of it until one arrives.
  it('refuses to move content out of a team space with no workspace id', () => {
    expect(canMoveBetweenSpaces(teamSpace(null), teamSpace('workspace-1'))).toBe(false);
  });
});
