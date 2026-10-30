import { resolveActiveWorkspaceId } from '../activeWorkspace';

describe('resolveActiveWorkspaceId', () => {
  it('picks the only workspace', () => {
    expect(resolveActiveWorkspaceId(['A'], [])).toBe('A');
  });

  it('picks the only entitled workspace among several', () => {
    expect(resolveActiveWorkspaceId(['A', 'B'], ['B'])).toBe('B');
  });

  it('picks none when several workspaces are entitled', () => {
    expect(resolveActiveWorkspaceId(['A', 'B'], ['A', 'B'])).toBeNull();
  });

  it('picks none when several workspaces and none is entitled', () => {
    expect(resolveActiveWorkspaceId(['A', 'B'], [])).toBeNull();
  });

  it('picks none without workspaces', () => {
    expect(resolveActiveWorkspaceId([], [])).toBeNull();
  });

  it('ignores an entitled workspace the user is not a member of', () => {
    expect(resolveActiveWorkspaceId(['A', 'B'], ['C'])).toBeNull();
  });
});
