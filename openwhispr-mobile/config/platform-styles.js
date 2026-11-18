const path = require('node:path');
const { createRequire } = require('node:module');
const { withNativeWind } = require('nativewind/metro');
const iosRequire = createRequire(require.resolve('nativewind-ios/package.json'));
const { withNativeWind: withIosNativeWind } = iosRequire('./metro');
const iosInteropRoot = path.dirname(iosRequire.resolve('react-native-css-interop/package.json'));

// Each CSS runtime keeps its own virtual styles. Bind the methods it wraps so both
// runtimes can compose their wrappers without skipping the other's refresh cache.
function withComposableStyleCache(metroServer) {
  const bundler = metroServer.getBundler().getBundler();
  const facade = new Proxy(bundler, {
    get(target, name) {
      if (name === 'transformFile') return target.transformFile.bind(target);
      if (name === 'getDependencyGraph') {
        return async () => {
          const graph = await target.getDependencyGraph();
          return new Proxy(graph, {
            get(graphTarget, graphName) {
              if (graphName !== '_fileSystem') return Reflect.get(graphTarget, graphName);
              return new Proxy(graphTarget._fileSystem, {
                get(fileSystem, method) {
                  const value = Reflect.get(fileSystem, method);
                  return typeof value === 'function' ? value.bind(fileSystem) : value;
                },
              });
            },
          });
        };
      }
      const value = Reflect.get(target, name);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return new Proxy(metroServer, {
    get(target, name) {
      if (name === 'getBundler') return () => ({ getBundler: () => facade });
      const value = Reflect.get(target, name);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function combineStyleConfigs(config, primary, ios) {
  const select = (platform) => (platform === 'ios' ? ios : primary);
  const transformSettings = (entry) => ({
    transformerPath: entry.transformerPath,
    cssInterop_transformerPath: entry.transformer.cssInterop_transformerPath,
    cssInterop_outputDirectory: entry.transformer.cssInterop_outputDirectory,
  });
  return {
    ...primary,
    transformerPath: require.resolve('./platform-styles-transformer'),
    transformer: {
      ...primary.transformer,
      platformStyles: { ios: transformSettings(ios), default: transformSettings(primary) },
      getTransformOptions(entryPoints, options, getDependenciesOf) {
        return select(options.platform).transformer.getTransformOptions(
          entryPoints,
          options,
          getDependenciesOf,
        );
      },
    },
    resolver: {
      ...primary.resolver,
      resolveRequest(context, moduleName, platform) {
        if (platform === 'ios') {
          if (moduleName === 'nativewind' || moduleName.startsWith('nativewind/')) {
            moduleName = moduleName.replace(/^nativewind/, 'nativewind-ios');
          } else if (
            moduleName === 'react-native-css-interop' ||
            moduleName.startsWith('react-native-css-interop/')
          ) {
            moduleName = iosInteropRoot + moduleName.slice('react-native-css-interop'.length);
          }
        }
        return select(platform).resolver.resolveRequest(context, moduleName, platform);
      },
    },
    server: {
      ...primary.server,
      enhanceMiddleware(middleware, metroServer) {
        const original = config.server?.enhanceMiddleware;
        const enhanced = original ? original(middleware, metroServer) : middleware;
        const primaryMiddleware = primary.server.enhanceMiddleware(
          enhanced,
          withComposableStyleCache(metroServer),
        );
        return ios.server.enhanceMiddleware(
          primaryMiddleware,
          withComposableStyleCache(metroServer),
        );
      },
    },
  };
}

function withPlatformNativeWind(config, options) {
  const withoutMiddleware = {
    ...config,
    server: { ...config.server, enhanceMiddleware: undefined },
  };
  const primary = withNativeWind(withoutMiddleware, options);
  const ios = withIosNativeWind(withoutMiddleware, {
    ...options,
    disableTypeScriptGeneration: true,
  });
  return combineStyleConfigs(config, primary, ios);
}

module.exports = { withPlatformNativeWind, combineStyleConfigs };
