const { withAppBuildGradle } = require('@expo/config-plugins');

const marker = '// OpenWhispr Android bundle inputs';

module.exports = (config) =>
  withAppBuildGradle(config, (result) => {
    if (result.modResults.contents.includes(marker)) return result;
    // React Native excludes every android directory and does not track JSON.
    // These are app sources, so edits must invalidate the embedded JS bundle.
    result.modResults.contents += `
${marker}
tasks.withType(com.facebook.react.tasks.BundleHermesCTask).configureEach {
    inputs.dir(file("../../src/android"))
        .withPropertyName("openWhisprAndroidSources")
        .withPathSensitivity(org.gradle.api.tasks.PathSensitivity.RELATIVE)
    inputs.dir(file("../../src/locales"))
        .withPropertyName("openWhisprLocales")
        .withPathSensitivity(org.gradle.api.tasks.PathSensitivity.RELATIVE)
}
`;
    return result;
  });
