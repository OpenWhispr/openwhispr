import type { Space } from '@/data';

/**
 * Where a note may move, mirroring desktop's canMoveBetweenSpaces
 * (openwhispr/src/lib/spacePermissions.ts): personal content can go anywhere, while team-space
 * content stays inside its own workspace — never to another workspace, and never back to the
 * private space. A team space with no workspace id (a skeleton mirrored before its backfill
 * completed) matches nothing, so nothing moves out of it.
 */
export function canMoveBetweenSpaces(
  from: Pick<Space, 'kind' | 'workspaceId'>,
  to: Pick<Space, 'kind' | 'workspaceId'>,
): boolean {
  if (from.kind === 'private') return true;
  return to.kind === 'team' && from.workspaceId != null && from.workspaceId === to.workspaceId;
}
