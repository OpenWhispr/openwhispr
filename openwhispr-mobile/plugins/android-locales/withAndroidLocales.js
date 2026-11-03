const { withAndroidManifest, withMainApplication } = require('@expo/config-plugins');

function configureMainApplication(source) {
  if (source.includes('// OpenWhispr per-app layout direction')) return source;
  if (
    !source.includes('super.onCreate()') ||
    !source.includes('super.onConfigurationChanged(newConfig)') ||
    !/\}\s*$/.test(source)
  ) {
    throw new Error('Android locale setup requires the expected Kotlin MainApplication lifecycle.');
  }
  return source
    .replace(
      'super.onCreate()',
      'super.onCreate()\n    applyOpenWhisprLayoutDirection(resources.configuration)',
    )
    .replace(
      'super.onConfigurationChanged(newConfig)',
      'super.onConfigurationChanged(newConfig)\n    applyOpenWhisprLayoutDirection(newConfig)',
    )
    .replace(
      /\}\s*$/,
      `  // OpenWhispr per-app layout direction
  // RN 0.83's device-locale fallback does not follow Android's per-app locale.
  // Set this before the React host starts, and update it on configuration changes.
  private fun applyOpenWhisprLayoutDirection(configuration: android.content.res.Configuration) {
    val rtl = configuration.layoutDirection == android.view.View.LAYOUT_DIRECTION_RTL
    val direction = com.facebook.react.modules.i18nmanager.I18nUtil.instance
    direction.allowRTL(this, true)
    direction.forceRTL(this, rtl)
  }
}
`,
    );
}

module.exports = (config) => {
  config = withAndroidManifest(config, (result) => {
    // Android deliberately excludes localeConfig from library manifest merging.
    result.modResults.manifest.application[0].$['android:localeConfig'] = '@xml/ow_locales';
    return result;
  });
  return withMainApplication(config, (result) => {
    if (result.modResults.language !== 'kt') {
      throw new Error('Android locale setup requires a Kotlin MainApplication.');
    }
    result.modResults.contents = configureMainApplication(result.modResults.contents);
    return result;
  });
};
module.exports.configureMainApplication = configureMainApplication;
