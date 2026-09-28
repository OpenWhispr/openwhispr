const {
  ensureStoreKitConfigurationReference,
  getCanonicalProductIds,
  validateStoreKitProductIds,
} = require('../withStoreKitConfiguration');

const SCHEME_WITHOUT_STOREKIT = `<?xml version="1.0" encoding="UTF-8"?>
<Scheme version = "1.3">
   <LaunchAction buildConfiguration = "Debug">
      <BuildableProductRunnable runnableDebuggingMode = "0">
      </BuildableProductRunnable>
   </LaunchAction>
</Scheme>
`;
const CANONICAL_REFERENCE = '../../Products.storekit';
const CANONICAL_PRODUCTS = {
  monthly: 'com.openwhispr.pro.monthly',
  annual: 'com.openwhispr.pro.annual',
};

function createStoreKitConfiguration(productIds: string[]): object {
  return {
    products: [],
    nonRenewingSubscriptions: [],
    subscriptionGroups: [
      {
        subscriptions: productIds.map((productID) => ({ productID })),
      },
    ],
  };
}

describe('withStoreKitConfiguration helpers', () => {
  it('inserts the StoreKit reference into the launch action', () => {
    const updatedScheme = ensureStoreKitConfigurationReference(
      SCHEME_WITHOUT_STOREKIT,
      CANONICAL_REFERENCE,
    );

    expect(updatedScheme).toContain(
      '<StoreKitConfigurationFileReference\n         identifier = "../../Products.storekit">',
    );
    expect(updatedScheme.indexOf('StoreKitConfigurationFileReference')).toBeLessThan(
      updatedScheme.indexOf('</LaunchAction>'),
    );
  });

  it('is idempotent when the canonical StoreKit reference already exists', () => {
    const once = ensureStoreKitConfigurationReference(SCHEME_WITHOUT_STOREKIT, CANONICAL_REFERENCE);
    const twice = ensureStoreKitConfigurationReference(once, CANONICAL_REFERENCE);

    expect(twice).toBe(once);
    expect(twice.match(/StoreKitConfigurationFileReference/g)).toHaveLength(2);
  });

  it('replaces a stale StoreKit reference without adding a second element', () => {
    const staleScheme = ensureStoreKitConfigurationReference(
      SCHEME_WITHOUT_STOREKIT,
      '../../OldProducts.storekit',
    );
    const updatedScheme = ensureStoreKitConfigurationReference(staleScheme, CANONICAL_REFERENCE);

    expect(updatedScheme).toContain('identifier = "../../Products.storekit"');
    expect(updatedScheme).not.toContain('OldProducts.storekit');
    expect(updatedScheme.match(/<StoreKitConfigurationFileReference/g)).toHaveLength(1);
  });

  it('rejects mismatched StoreKit product IDs', () => {
    const storeKitConfiguration = createStoreKitConfiguration([
      CANONICAL_PRODUCTS.monthly,
      'com.openwhispr.pro.yearly',
    ]);

    expect(() => validateStoreKitProductIds(storeKitConfiguration, CANONICAL_PRODUCTS)).toThrow(
      'StoreKit product IDs must exactly match the canonical product IDs',
    );
  });

  it('rejects missing StoreKit product IDs', () => {
    const storeKitConfiguration = createStoreKitConfiguration([CANONICAL_PRODUCTS.monthly]);

    expect(() => validateStoreKitProductIds(storeKitConfiguration, CANONICAL_PRODUCTS)).toThrow(
      'StoreKit product IDs must exactly match the canonical product IDs',
    );
  });

  it('accepts exactly the canonical monthly and annual product IDs', () => {
    const storeKitConfiguration = createStoreKitConfiguration([
      CANONICAL_PRODUCTS.annual,
      CANONICAL_PRODUCTS.monthly,
    ]);

    expect(getCanonicalProductIds(CANONICAL_PRODUCTS)).toEqual([
      'com.openwhispr.pro.monthly',
      'com.openwhispr.pro.annual',
    ]);
    expect(() =>
      validateStoreKitProductIds(storeKitConfiguration, CANONICAL_PRODUCTS),
    ).not.toThrow();
  });
});
