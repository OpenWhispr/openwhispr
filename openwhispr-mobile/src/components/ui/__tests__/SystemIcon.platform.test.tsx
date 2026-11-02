// The SVG renderer needs a device runtime; the import boundary is under test.
jest.mock('lucide-react-native', () => ({}));

jest.mock('react-i18next', () => {
  throw new Error('Android translation runtime reached the default icon implementation');
});

it('loads the default icon implementation without the Android translation runtime', () => {
  expect(() => require('../SystemIcon')).not.toThrow();
});
