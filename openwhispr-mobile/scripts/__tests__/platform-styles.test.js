const assert = require('node:assert/strict');
const { Buffer } = require('node:buffer');
const path = require('node:path');
const { test } = require('node:test');
const { createRequire } = require('node:module');
const project = path.resolve(__dirname, '../..');
process.chdir(project);
const req = createRequire(path.join(project, 'package.json'));
const iosReq = createRequire(req.resolve('nativewind-ios/package.json'));
const { combineStyleConfigs } = req('./config/platform-styles');
const versions = {
  android: req('react-native-css-interop/metro'),
  ios: iosReq('react-native-css-interop/metro'),
};
let originalMiddlewareCalls = 0;
const calls = [],
  changes = [],
  callbacks = {};
const input = path.join(project, 'global.css');
const base = {
  resolver: {
    sourceExts: ['js'],
    resolveRequest: (_context, name, platform) => ({
      type: 'sourceFile',
      filePath: name === './global.css' ? input : name,
    }),
  },
  transformer: {
    getTransformOptions: async (_entry, options) => ({
      transform: { inlineRequires: options.platform === 'android' },
    }),
  },
  server: {
    enhanceMiddleware: (middleware) => {
      originalMiddlewareCalls++;
      return middleware;
    },
  },
};
const build = (platform) =>
  versions[platform].withCssInterop(
    { ...base, server: {} },
    {
      input,
      getCSSForPlatform: async (requested, onChange) => {
        assert.equal(requested, platform);
        callbacks[platform] = onChange;
        calls.push([platform, 'start']);
        return `.color { color: ${platform === 'ios' ? 'red' : 'blue'}; }`;
      },
    },
  );
const config = combineStyleConfigs(base, build('android'), build('ios'));
const transformed = [];
const fileSystem = {
  getSha1(filename) {
    return `original:${filename}`;
  },
  lookup() {
    return { exists: true, realPath: project };
  },
};
const graph = {
  _fileSystem: fileSystem,
  _haste: {
    emit(name, data) {
      changes.push({ name, data });
    },
  },
};
const bundler = {
  getDependencyGraph: async () => graph,
  transformFile: async (filename, options, data) => {
    transformed.push({ filename, platform: options.platform, data: data?.toString() });
    return data;
  },
};
const server = { getBundler: () => ({ getBundler: () => bundler }) };
test('both platform styling caches compose and refresh independently', async () => {
  config.server.enhanceMiddleware((_req, _res, next) => next(), server);
  await new Promise(setImmediate);
  assert.equal(originalMiddlewareCalls, 1);
  const paths = {};
  for (const platform of ['ios', 'android']) {
    const opts = await config.transformer.getTransformOptions(
      [],
      { platform, dev: true },
      () => [],
    );
    assert.equal(opts.transform.inlineRequires, platform === 'android');
    paths[platform] = config.resolver.resolveRequest(
      { isDev: true },
      './global.css',
      platform,
    ).filePath;
    const cacheKey = fileSystem.getSha1(paths[platform]);
    assert(!cacheKey.startsWith('original:'), platform + ' virtual hash was skipped');
    await bundler.transformFile(paths[platform], { platform }, Buffer.from('UNPROCESSED'));
    assert(!transformed.at(-1).data.includes('UNPROCESSED'));
    assert(
      transformed.at(-1).data.includes(platform === 'ios' ? '#ff0000' : '#0000ff'),
      transformed.at(-1).data,
    );
  }
  assert.deepEqual(calls, [
    ['ios', 'start'],
    ['android', 'start'],
  ]);
  assert.notEqual(paths.ios, paths.android);
  for (const platform of ['android', 'ios', 'android', 'ios']) {
    const color = platform === 'ios' ? 'green' : 'yellow';
    callbacks[platform](`.color { color: ${color}; }`);
    await bundler.transformFile(paths[platform], { platform }, Buffer.from('UNPROCESSED'));
    assert(
      transformed.at(-1).data.includes(platform === 'ios' ? '#008000' : '#ffff00'),
      platform + ' lost its style refresh: ' + transformed.at(-1).data,
    );
  }
  assert.equal(changes.length, 4);
  assert(changes[0].data.changes);
  assert.equal(changes[1].data.changes, undefined); // Upstream iOS event format is preserved.
  assert.equal(fileSystem.getSha1('/unrelated.js'), 'original:/unrelated.js');
  await bundler.transformFile('/unrelated.js', { platform: 'ios' }, Buffer.from('original-data'));
  assert.equal(transformed.at(-1).data, 'original-data');
  for (const name of [
    'nativewind',
    'nativewind/jsx-runtime',
    'react-native-css-interop',
    'react-native-css-interop/dist/runtime/native/styles',
  ]) {
    const android = config.resolver.resolveRequest({}, name, 'android').filePath;
    const ios = config.resolver.resolveRequest({}, name, 'ios').filePath;
    assert.equal(android, name);
    assert(ios.includes('nativewind-ios'), name);
  }
});
