const { withDangerousMod } = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');

const STOREKIT_FILE_NAME = 'Products.storekit';
const CANONICAL_PRODUCTS_PATH = path.join('config', 'storekit-products.json');
const STOREKIT_SCHEME_REFERENCE = `../../${STOREKIT_FILE_NAME}`;
const STOREKIT_REFERENCE_PATTERN =
  /^[ \t]*<StoreKitConfigurationFileReference\b[\s\S]*?^[ \t]*<\/StoreKitConfigurationFileReference>[ \t]*(?:\r?\n)?/gm;

function getCanonicalProductIds(canonicalProducts) {
  const keys = Object.keys(canonicalProducts);
  if (
    keys.length !== 2 ||
    !keys.includes('monthly') ||
    !keys.includes('annual') ||
    typeof canonicalProducts.monthly !== 'string' ||
    canonicalProducts.monthly.length === 0 ||
    typeof canonicalProducts.annual !== 'string' ||
    canonicalProducts.annual.length === 0 ||
    canonicalProducts.monthly === canonicalProducts.annual
  ) {
    throw new Error('Canonical StoreKit products must define distinct monthly and annual IDs');
  }
  return [canonicalProducts.monthly, canonicalProducts.annual];
}

function getStoreKitProductIds(storeKitConfiguration) {
  const standaloneProducts = [
    ...(Array.isArray(storeKitConfiguration.products) ? storeKitConfiguration.products : []),
    ...(Array.isArray(storeKitConfiguration.nonRenewingSubscriptions)
      ? storeKitConfiguration.nonRenewingSubscriptions
      : []),
  ];
  const subscriptionGroups = Array.isArray(storeKitConfiguration.subscriptionGroups)
    ? storeKitConfiguration.subscriptionGroups
    : [];
  const subscriptions = subscriptionGroups.flatMap((group) =>
    Array.isArray(group.subscriptions) ? group.subscriptions : [],
  );

  return [...standaloneProducts, ...subscriptions]
    .map((product) => product.productID)
    .filter((productId) => typeof productId === 'string');
}

function validateStoreKitProductIds(storeKitConfiguration, canonicalProducts) {
  const expectedProductIds = getCanonicalProductIds(canonicalProducts).sort();
  const actualProductIds = getStoreKitProductIds(storeKitConfiguration).sort();
  if (
    actualProductIds.length !== expectedProductIds.length ||
    actualProductIds.some((productId, index) => productId !== expectedProductIds[index])
  ) {
    throw new Error(
      `StoreKit product IDs must exactly match the canonical product IDs: ${expectedProductIds.join(', ')}`,
    );
  }
}

function createStoreKitReferenceBlock(indentation, reference) {
  const childIndentation = `${indentation}   `;
  return `${childIndentation}<StoreKitConfigurationFileReference
${childIndentation}   identifier = "${reference}">
${childIndentation}</StoreKitConfigurationFileReference>
`;
}

function ensureStoreKitConfigurationReference(schemeContents, reference) {
  const schemeWithoutStoreKitReference = schemeContents.replace(STOREKIT_REFERENCE_PATTERN, '');
  const launchActionClosingPattern = /^([ \t]*)<\/LaunchAction>/m;
  if (!launchActionClosingPattern.test(schemeWithoutStoreKitReference)) {
    throw new Error('StoreKit configuration plugin could not find the scheme LaunchAction');
  }

  return schemeWithoutStoreKitReference.replace(
    launchActionClosingPattern,
    (_closingTag, indentation) =>
      `${createStoreKitReferenceBlock(indentation, reference)}${indentation}</LaunchAction>`,
  );
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function withStoreKitConfiguration(config) {
  return withDangerousMod(config, [
    'ios',
    (cfg) => {
      const projectRoot = cfg.modRequest.projectRoot;
      const platformProjectRoot = cfg.modRequest.platformProjectRoot;
      const projectName = cfg.modRequest.projectName ?? 'OpenWhispr';
      const canonicalProducts = readJson(path.join(projectRoot, CANONICAL_PRODUCTS_PATH));
      const storeKitConfiguration = readJson(path.join(projectRoot, STOREKIT_FILE_NAME));
      validateStoreKitProductIds(storeKitConfiguration, canonicalProducts);

      const schemePath = path.join(
        platformProjectRoot,
        `${projectName}.xcodeproj`,
        'xcshareddata',
        'xcschemes',
        `${projectName}.xcscheme`,
      );
      const currentScheme = fs.readFileSync(schemePath, 'utf8');
      const updatedScheme = ensureStoreKitConfigurationReference(
        currentScheme,
        STOREKIT_SCHEME_REFERENCE,
      );
      if (updatedScheme !== currentScheme) fs.writeFileSync(schemePath, updatedScheme);
      return cfg;
    },
  ]);
}

module.exports = withStoreKitConfiguration;
module.exports.ensureStoreKitConfigurationReference = ensureStoreKitConfigurationReference;
module.exports.getCanonicalProductIds = getCanonicalProductIds;
module.exports.validateStoreKitProductIds = validateStoreKitProductIds;
