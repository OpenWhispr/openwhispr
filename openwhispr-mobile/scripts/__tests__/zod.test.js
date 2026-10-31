const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const path = require('node:path');
const { test } = require('node:test');
const lockfile = require('../../package-lock.json');

const mobileRoot = path.resolve(__dirname, '../..');
const zodPaths = Object.keys(lockfile.packages).filter((entry) =>
  entry.endsWith('node_modules/zod'),
);
assert.ok(zodPaths.length > 0, 'Expected Zod in the mobile dependency tree');

// GHSA-mrhx-c7xc-m3w5: a size limit must reject before walking invalid elements.
// Keep the fixture tiny; traversal counts prove the flaw without exhausting memory.
for (const zodPath of zodPaths) {
  const { z } = require(path.resolve(mobileRoot, zodPath));
  test(`${zodPath}: rejects oversized arrays before parsing their elements`, () => {
    let visits = 0;
    const element = z.preprocess((value) => {
      visits++;
      return value;
    }, z.string());
    const result = z.array(element).max(1).safeParse([0, 0]);
    assert.equal(result.success, false);
    assert.equal(visits, 0);
    assert.deepEqual(
      result.error.issues.map((issue) => issue.code),
      ['too_big'],
    );
    assert.deepEqual(z.array(element).max(1).parse(['valid']), ['valid']);
  });
}

// Exercise Expo's actual consumers, not copies of their schemas. The scoped
// override crosses a major version until Expo CLI itself adopts patched Zod.
const expoRequire = createRequire(require.resolve('expo/package.json'));
const cliRequire = createRequire(expoRequire.resolve('@expo/cli/package.json'));
const { PluginSchema, DevToolsPluginOutputSchema } = cliRequire(
  './build/src/start/server/DevToolsPlugin.schema.js',
);
const { createMCPDevToolsExtensionSchema } = cliRequire(
  './build/src/start/server/createMCPDevToolsExtensionSchema.js',
);
const { DevToolsPluginCliExtensionResults } = cliRequire(
  './build/src/start/server/DevToolsPluginCliExtensionResults.js',
);
const plugin = {
  packageName: 'fixture-plugin',
  packageRoot: '/fixture',
  cliExtensions: {
    description: 'Fixture commands',
    entryPoint: './fixture.js',
    commands: [
      {
        name: 'inspect',
        title: 'Inspect fixture',
        environments: ['cli', 'mcp'],
        parameters: [
          { name: 'label', type: 'text' },
          { name: 'count', type: 'number' },
          { name: 'confirmed', type: 'confirm' },
        ],
      },
    ],
  },
};

test('Expo plugin descriptors retain required fields and reject invalid command types', () => {
  assert.deepEqual(PluginSchema.parse(plugin), plugin);
  assert.equal(PluginSchema.safeParse({ ...plugin, packageName: '' }).success, false);
  const invalid = JSON.parse(JSON.stringify(plugin));
  invalid.cliExtensions.commands[0].parameters[0].type = 'unsupported';
  assert.equal(PluginSchema.safeParse(invalid).success, false);
  assert.equal(
    Object.isFrozen(PluginSchema.parse(plugin).cliExtensions.commands[0].environments),
    true,
  );
});

test('Expo command schemas preserve optional typed parameters and reject unknown input', () => {
  const schema = createMCPDevToolsExtensionSchema(plugin);
  assert.deepEqual(schema.parse({ command: 'inspect' }), { command: 'inspect' });
  const input = { command: 'inspect', label: 'fixture', count: 2, confirmed: false };
  assert.deepEqual(schema.parse(input), input);
  for (const invalid of [
    { command: 'unknown' },
    { command: 'inspect', count: '2' },
    { command: 'inspect', label: 2 },
    { command: 'inspect', confirmed: 'false' },
    { command: 'inspect', extra: true },
  ]) {
    assert.equal(schema.safeParse(invalid).success, false);
  }
});

test('Expo output parsing retains valid text and media while rejecting malformed results', () => {
  const valid = [
    { type: 'text', text: 'fixture', level: 'info' },
    { type: 'audio', url: 'https://example.invalid/audio.wav' },
    { type: 'image', url: 'https://example.invalid/image.png', text: 'fixture' },
  ];
  assert.deepEqual(DevToolsPluginOutputSchema.parse(valid), valid);
  assert.equal(
    DevToolsPluginOutputSchema.safeParse([{ type: 'audio', url: 'invalid' }]).success,
    false,
  );
  const results = new DevToolsPluginCliExtensionResults();
  results.append(JSON.stringify(valid));
  results.append('plain output', 'warning');
  assert.deepEqual(results.getOutput(), [
    ...valid,
    { type: 'text', text: 'plain output', level: 'warning' },
  ]);
  const malformed = results.parseOutputText('[{"type":"invalid"}]');
  assert.equal(malformed[0].level, 'error');
  assert.match(malformed[0].text, /^Invalid JSON:/);
});
