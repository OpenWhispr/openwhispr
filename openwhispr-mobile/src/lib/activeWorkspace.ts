/**
 * The workspace whose shared dictionary applies on this device. Mobile has no
 * workspace picker, so it is only ever an unambiguous one: the user's only
 * workspace, else the only one they are entitled through. Anything else
 * resolves to none and no shared words apply.
 */
export function resolveActiveWorkspaceId(
  workspaceIds: string[],
  entitledWorkspaceIds: string[],
): string | null {
  const memberOf = new Set(workspaceIds);
  if (memberOf.size === 1) return workspaceIds[0];
  const entitled = new Set(entitledWorkspaceIds.filter((id) => memberOf.has(id)));
  return entitled.size === 1 ? [...entitled][0] : null;
}
