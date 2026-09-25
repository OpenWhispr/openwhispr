import { isShareVisibilityAllowed } from '../noteSharePolicy';

it('allows every mode when sharing is unrestricted or the policy is unknown', () => {
  for (const mode of ['allowed', null] as const) {
    expect(isShareVisibilityAllowed(mode, 'link')).toBe(true);
    expect(isShareVisibilityAllowed(mode, 'invited')).toBe(true);
    expect(isShareVisibilityAllowed(mode, 'domain')).toBe(true);
  }
});

it('limits a domain-only organization to domain sharing, like the server', () => {
  expect(isShareVisibilityAllowed('domain_only', 'domain')).toBe(true);
  expect(isShareVisibilityAllowed('domain_only', 'invited')).toBe(false);
  expect(isShareVisibilityAllowed('domain_only', 'link')).toBe(false);
});

it('keeps making a note private available when sharing is disabled', () => {
  expect(isShareVisibilityAllowed('disabled', 'private')).toBe(true);
  expect(isShareVisibilityAllowed('disabled', 'domain')).toBe(false);
  expect(isShareVisibilityAllowed('disabled', 'invited')).toBe(false);
});
