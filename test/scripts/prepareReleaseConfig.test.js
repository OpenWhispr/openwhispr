const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createReleaseConfig,
  resolveReleaseRepository,
  validateReleaseIdentity,
} = require("../../scripts/prepare-release-config");
const { loadDistribution } = require("../../src/config/distributionSchema.ts");

const baseConfig = {
  appId: "com.gizmolabs.openwhispr",
  productName: "OpenWhispr",
  protocols: {
    name: "OpenWhispr Protocol",
    schemes: ["openwhispr"],
  },
  mac: {
    identity: "Gizmo Labs Inc. (TEAMID)",
    notarize: true,
    extendInfo: {
      NSMicrophoneUsageDescription: "OpenWhispr uses the microphone.",
    },
  },
  win: {
    azureSignOptions: {
      certificateProfileName: "openwhispr-release",
      codeSigningAccountName: "OpenWhispr",
    },
  },
  dmg: { title: "OpenWhispr" },
  publish: {
    provider: "github",
    owner: "OpenWhispr",
    repo: "openwhispr",
    private: false,
    releaseType: "draft",
  },
};

test("creates a renamed release config for the current repository", () => {
  const config = createReleaseConfig(baseConfig, {
    productName: "New Whispr",
    appId: "engineering.oppulence.newwhispr",
    protocolScheme: "newwhispr",
    repository: "PlaybookMediaLLC/openwhispr",
    repositoryPrivate: true,
  });

  assert.equal(config.productName, "New Whispr");
  assert.equal(config.appId, "engineering.oppulence.newwhispr");
  assert.deepEqual(config.protocols, {
    name: "New Whispr Protocol",
    schemes: ["newwhispr"],
  });
  assert.equal(config.dmg.title, "New Whispr");
  assert.deepEqual(config.extraMetadata.releaseIdentity, {
    productName: "New Whispr",
    appId: "engineering.oppulence.newwhispr",
    protocolScheme: "newwhispr",
  });
  assert.equal(
    config.mac.extendInfo.NSMicrophoneUsageDescription,
    "New Whispr uses the microphone."
  );
  assert.deepEqual(config.publish, {
    provider: "github",
    owner: "PlaybookMediaLLC",
    repo: "openwhispr",
    private: true,
    releaseType: "draft",
  });
  assert.equal(config.win.azureSignOptions.codeSigningAccountName, "OpenWhispr");
});

test("disables unavailable platform signing without changing the base config", () => {
  const config = createReleaseConfig(baseConfig, {
    productName: "OpenWhispr",
    appId: "com.gizmolabs.openwhispr",
    protocolScheme: "openwhispr",
    repository: "OpenWhispr/openwhispr",
    unsignedWindows: true,
    unsignedMacos: true,
  });

  assert.equal(config.win.azureSignOptions, null);
  assert.equal(config.mac.identity, null);
  assert.equal(config.mac.notarize, false);
  assert.notEqual(baseConfig.win.azureSignOptions, null);
  assert.equal(baseConfig.mac.notarize, true);
});

test("requires renamed releases to use a distinct application identity", () => {
  assert.throws(
    () =>
      validateReleaseIdentity({
        productName: "New Whispr",
        appId: "com.gizmolabs.openwhispr",
        protocolScheme: "newwhispr",
        repository: "PlaybookMediaLLC/openwhispr",
      }),
    /non-OpenWhispr RELEASE_APP_ID/
  );

  assert.throws(
    () =>
      validateReleaseIdentity({
        productName: "New Whispr",
        appId: "engineering.oppulence.newwhispr",
        protocolScheme: "openwhispr",
        repository: "PlaybookMediaLLC/openwhispr",
      }),
    /non-OpenWhispr RELEASE_PROTOCOL_SCHEME/
  );
});

test("requires forks to use an application identity distinct from canonical OpenWhispr", () => {
  assert.throws(
    () =>
      createReleaseConfig(baseConfig, {
        productName: "OpenWhispr",
        appId: "com.gizmolabs.openwhispr",
        protocolScheme: "openwhispr",
        repository: "PlaybookMediaLLC/openwhispr",
      }),
    /fork release must use a non-OpenWhispr RELEASE_APP_ID/
  );
});

test("an Oppulence release never inherits the upstream Windows signing profile", () => {
  const distribution = loadDistribution("distributions/oppulence-voice.json", process.cwd());
  const config = createReleaseConfig(baseConfig, {
    productName: distribution.productName,
    appId: distribution.appId,
    protocolScheme: distribution.protocolScheme,
    repository: `${distribution.updates.owner}/${distribution.updates.repo}`,
    distribution,
  });

  assert.equal(config.win.azureSignOptions, null);
  assert.equal(config.extraMetadata.distribution.id, "oppulence-voice");
  // Packagers want a real multi-resolution icon per platform, not one PNG:
  // .icns for the Mac app and DMG, .ico for Windows, PNG only for Linux.
  assert.equal(config.mac.icon, "distributions/oppulence-voice/assets/oppulence-mark.icns");
  assert.equal(config.win.icon, "distributions/oppulence-voice/assets/oppulence-mark.ico");
  assert.equal(config.linux.icon, "distributions/oppulence-voice/assets/oppulence-mark.png");
  assert.equal(config.dmg.icon, "distributions/oppulence-voice/assets/oppulence-mark.icns");
  assert.deepEqual(config.mac.extraResources, []);
  assert.equal(config.mac.extendInfo.CFBundleIconName, undefined);
});

test("release CI cannot redirect an Oppulence updater to the checkout repository", () => {
  const distribution = loadDistribution("distributions/oppulence-voice.json", process.cwd());
  assert.equal(resolveReleaseRepository(distribution), "PlaybookMediaLLC/openwhispr");
  // A fork or a mirror running this workflow must not be able to publish
  // updates that the shipped app would then install.
  assert.throws(
    () => resolveReleaseRepository(distribution, "someone-else/openwhispr"),
    /does not match distribution updater repository/
  );
});
