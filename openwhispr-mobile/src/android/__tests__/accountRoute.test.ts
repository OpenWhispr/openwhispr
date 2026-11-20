import { routeToRestore } from '../accountRoute';

describe('screens reopened after an account change', () => {
  it('reopens Settings, sign-in and the reset and verify screens with their params', () => {
    expect(routeToRestore(['(account)'], {})).toEqual({ pathname: '/(account)', params: {} });
    expect(routeToRestore(['auth'], { reason: 'sync' })).toEqual({
      pathname: '/auth',
      params: { reason: 'sync' },
    });
    expect(routeToRestore(['android-reset-password'], { token: 't', x: ['a'] })).toEqual({
      pathname: '/android-reset-password',
      params: { token: 't' },
    });
    expect(routeToRestore(['android-verify-email'], { token: 't' })?.pathname).toBe(
      '/android-verify-email',
    );
  });

  it('never reopens anything that holds the previous account’s data', () => {
    expect(routeToRestore(['(tabs)', '(notes)', 'note', '[id]'], { id: '7' })).toBeNull();
    expect(routeToRestore(['(account)', 'profile'], {})).toBeNull();
    expect(routeToRestore(['android-history'], {})).toBeNull();
    expect(routeToRestore([], {})).toBeNull();
  });
});
