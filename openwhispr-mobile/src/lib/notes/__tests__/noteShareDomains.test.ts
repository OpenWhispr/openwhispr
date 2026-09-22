import { emailDomain, isPersonalEmailDomain } from '../noteShareDomains';

it('extracts normalized address domains including display-name forms', () => {
  expect(emailDomain('  Ada <A@Example.COM> ')).toBe('example.com');
  expect(emailDomain('invalid')).toBe('');
});

it('classifies desktop personal domains exactly', () => {
  expect(isPersonalEmailDomain('GMAIL.COM')).toBe(true);
  expect(isPersonalEmailDomain('example.com')).toBe(false);
});
