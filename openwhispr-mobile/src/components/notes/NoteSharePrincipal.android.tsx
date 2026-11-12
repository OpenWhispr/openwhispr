import { useAndroidCopy } from '@/hooks/useAndroidCopy';
import type { NoteAccessPrincipalType } from '@/data/remote/noteSharingTypes';
export { PRINCIPAL_LABEL, RowIcon, PrincipalAvatar } from './NoteSharePrincipalCore.android';

/** Keep principal types as stable server identities; translate only their display labels. */
export function usePrincipalLabels(): Record<NoteAccessPrincipalType, string> {
  const { copy } = useAndroidCopy();
  return {
    user: copy('noteAccess.person', 'Person'),
    email: copy('noteAccess.email', 'Email'),
    team: copy('noteAccess.team', 'Team'),
    space: copy('noteAccess.space', 'Team space'),
    folder: copy('noteAccess.folder', 'Folder'),
    workspace: copy('noteAccess.workspace', 'Workspace'),
  };
}
