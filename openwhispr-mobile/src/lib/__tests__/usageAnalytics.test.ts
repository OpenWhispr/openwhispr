import { isUsageAnalyticsAllowed } from '../usageAnalytics';

it('defaults to on once config has loaded, and fails closed before that', () => {
  expect(isUsageAnalyticsAllowed(null)).toBe(false);
  expect(isUsageAnalyticsAllowed({ defaultMode: 'cloud' })).toBe(true);
  expect(isUsageAnalyticsAllowed({ defaultMode: 'cloud', usageAnalyticsEnabled: true })).toBe(true);
  expect(isUsageAnalyticsAllowed({ defaultMode: 'cloud', usageAnalyticsEnabled: false })).toBe(
    false,
  );
});
