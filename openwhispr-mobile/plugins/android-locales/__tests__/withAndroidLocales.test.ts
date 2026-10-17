export {};

jest.mock('@expo/config-plugins', () => ({
  withAndroidManifest: (config: unknown) => config,
  withMainApplication: (config: unknown) => config,
}));
const { configureMainApplication } = require('../withAndroidLocales');

const application = `package test.app
class MainApplication : Application() {
  override fun onCreate() {
    super.onCreate()
    loadReactNative(this)
    ApplicationLifecycleDispatcher.onApplicationCreate(this)
  }
  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    ApplicationLifecycleDispatcher.onConfigurationChanged(this, newConfig)
  }
}`;

it('sets per-app layout direction before React Native starts and before locale dispatch', () => {
  const result = configureMainApplication(application);
  expect(result.indexOf('applyOpenWhisprLayoutDirection(resources.configuration)')).toBeLessThan(
    result.indexOf('loadReactNative(this)'),
  );
  expect(result.indexOf('applyOpenWhisprLayoutDirection(newConfig)')).toBeLessThan(
    result.indexOf('ApplicationLifecycleDispatcher.onConfigurationChanged'),
  );
  expect(result).toContain(
    'configuration.layoutDirection == android.view.View.LAYOUT_DIRECTION_RTL',
  );
  expect(result).toContain('direction.forceRTL(this, rtl)');
  expect(result).not.toContain('getAvailableLocales');
});

it('preserves unrelated native initialization and is idempotent across prebuilds', () => {
  const result = configureMainApplication(application);
  expect(configureMainApplication(result)).toBe(result);
  expect(result).toContain('loadReactNative(this)');
  expect(result).toContain('ApplicationLifecycleDispatcher.onApplicationCreate(this)');
});

it('fails rather than silently building without the locale hooks when the template changes', () => {
  expect(() => configureMainApplication('class OtherApplication {}')).toThrow();
});
