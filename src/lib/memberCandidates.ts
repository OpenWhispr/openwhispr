// The current user is a valid pick-list candidate (e.g. a workspace admin
// adding themself to an existing team); pinning them first keeps the
// common case one click away.
export function orderMemberCandidates<M extends { user_id: string }>(
  members: M[],
  currentUserId: string | null | undefined
): M[] {
  if (!currentUserId) return members;
  const self = members.filter((m) => m.user_id === currentUserId);
  if (self.length === 0) return members;
  return [...self, ...members.filter((m) => m.user_id !== currentUserId)];
}
