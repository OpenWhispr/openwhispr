import { getAccountDisplay } from '@/lib/accountDisplay';

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
