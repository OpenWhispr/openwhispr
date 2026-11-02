import type { AuthUser } from '@/lib/authClient';
import { getAccountDisplay, getAccountFirstName } from '@/lib/accountDisplay';

describe('getAccountDisplay', () => {
  it('shows a real account by name and email', () => {
    expect(
      getAccountDisplay(
        {
          id: 'u',
          email: 'ada@example.com',
          name: 'Ada Lovelace',
          emailVerified: true,
          isAnonymous: false,
        },
        false,
      ),
    ).toEqual({ initials: 'AL', name: 'Ada Lovelace', subtitle: 'ada@example.com' });
  });

  it('describes guest mode', () => {
    expect(getAccountDisplay(null, true)).toEqual({
      initials: '?',
      name: 'Guest Mode',
      subtitle: 'Local notes only',
    });
  });

  // The server gives an anonymous session a placeholder identity (name
  // "Anonymous", a machine address on a reserved domain). Neither is the
  // user's; show the absence of an account instead.
  it('does not present the placeholder identity of an anonymous session', () => {
    expect(
      getAccountDisplay(
        {
          id: 'anon',
          email: 'temp-1@anon.openwhispr.invalid',
          name: 'Anonymous',
          emailVerified: false,
          isAnonymous: true,
        },
        false,
      ),
    ).toEqual({ initials: '?', name: 'OpenWhispr User', subtitle: 'No account yet' });
  });
});

describe('getAccountFirstName', () => {
  const user = (overrides: Partial<AuthUser>): AuthUser => ({
    id: 'u',
    email: 'ada@example.com',
    emailVerified: true,
    isAnonymous: false,
    ...overrides,
  });

  it('takes the first word of the name', () => {
    expect(getAccountFirstName(user({ name: '  Ada   Lovelace ' }))).toBe('Ada');
  });

  it('has none for a guest, a nameless account or an anonymous session', () => {
    expect(getAccountFirstName(null)).toBeNull();
    expect(getAccountFirstName(user({ name: undefined }))).toBeNull();
    expect(getAccountFirstName(user({ name: '   ' }))).toBeNull();
    expect(getAccountFirstName(user({ name: 'Anonymous', isAnonymous: true }))).toBeNull();
  });

  it('has none when the name is only the email address or its handle', () => {
    expect(getAccountFirstName(user({ name: 'Ada' }))).toBe('Ada');
    expect(getAccountFirstName(user({ name: 'ada' }))).toBeNull();
    expect(getAccountFirstName(user({ name: 'ada@example.com' }))).toBeNull();
  });
});
