import type { AuthUser } from '@/lib/authClient';

export type AccountDisplay = {
  initials: string;
  name: string;
  subtitle: string;
};

export function getAccountDisplay(
  user: AuthUser | null,
  isGuest: boolean,
  guestSubtitle = 'Local notes only',
): AccountDisplay {
  // The server gives an anonymous session a placeholder identity ("Anonymous",
  // a machine address on a reserved domain). Neither is the user's.
  if (user?.isAnonymous) {
    return { initials: '?', name: 'OpenWhispr User', subtitle: 'No account yet' };
  }
  const initials = user?.name
    ? user.name
        .split(' ')
        .map((n) => n[0])
        .join('')
        .toUpperCase()
        .slice(0, 2)
    : (user?.email?.[0]?.toUpperCase() ?? '?');

  const name = user?.name || (isGuest ? 'Guest Mode' : 'OpenWhispr User');
  const subtitle = user?.email || guestSubtitle;

  return { initials, name, subtitle };
}
