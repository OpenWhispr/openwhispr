import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { androidArguments, stageAndroidArchive } from '../eas-android.mjs';

const mobile = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const script = join(mobile, 'scripts/eas-android.mjs');
const git = (cwd, args) =>
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
const pause = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));

async function fixture() {
  const folder = await mkdtemp(join(tmpdir(), 'android-eas-test-'));
  const source = join(folder, 'source'),
    scratch = join(folder, 'scratch');
  const project = join(source, 'openwhispr-mobile');
  await mkdir(join(project, 'scripts'), { recursive: true });
  await mkdir(join(project, 'config'));
  await mkdir(scratch);
  await copyFile(script, join(project, 'scripts/eas-android.mjs'));
  await copyFile(
    join(mobile, 'config/easignore.android'),
    join(project, 'config/easignore.android'),
  );
  await writeFile(join(source, '.gitignore'), 'node_modules\n.env*\n/openwhispr-mobile/android\n');
  await writeFile(join(project, 'source.txt'), 'fixture source');
  git(source, ['init', '-b', 'chore/android-archive-fixture']);
  git(source, ['add', '.']);
  git(source, [
    '-c',
    'user.name=Archive fixture',
    '-c',
    'user.email=archive-fixture@example.invalid',
    'commit',
    '-m',
    'Archive fixture',
  ]);
  for (const [file, contents] of [
    ['.env.fixture', 'synthetic dotenv'],
    ['node_modules/fixture.txt', 'synthetic dependency'],
    ['android/fixture.txt', 'synthetic native state'],
  ]) {
    const target = join(project, file);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
  return {
    folder,
    source,
    project,
    scratch,
    cleanup: () => rm(folder, { recursive: true, force: true }),
  };
}

test('forces Android and preserves output paths relative to the invoking directory', () => {
  const directory = resolve('fixture output');
  assert.deepEqual(androidArguments(['build', '--profile', 'android-play-test'], directory), [
    'build',
    '--profile',
    'android-play-test',
    '--platform',
    'android',
  ]);
  for (const flag of ['--output', '-o'])
    assert.deepEqual(
      androidArguments(['build:inspect', flag, 'a b;$x', '--stage', 'archive'], directory),
      [
        'build:inspect',
        flag,
        join(directory, 'a b;$x'),
        '--stage',
        'archive',
        '--platform',
        'android',
      ],
    );
  assert.deepEqual(androidArguments(['build', '--output=a b'], directory), [
    'build',
    '--output=' + join(directory, 'a b'),
    '--platform',
    'android',
  ]);
  for (const args of [
    [],
    ['update'],
    ['build', '--platform', 'ios'],
    ['build', '--platform=all'],
    ['build', '-p', 'ios'],
    ['build', '-pios'],
    ['build', '-vpiOS'],
    ['build', '--'],
    ['build', '--output'],
    ['build', '--output='],
  ])
    assert.throws(() => androidArguments(args, directory));
});

test('stages local inputs, staged changes, source metadata and links without modifying the source', async () => {
  const item = await fixture();
  let stage;
  try {
    await writeFile(join(item.project, 'source.txt'), 'staged change');
    git(item.source, ['add', '.']);
    await writeFile(join(item.project, 'source.txt'), 'working-tree change');
    await writeFile(join(item.project, 'untracked.txt'), 'untracked source');
    await symlink('source.txt', join(item.project, 'source-link'));
    const status = git(item.source, ['status', '--porcelain', '--untracked-files=all']);
    stage = await stageAndroidArchive(
      item.source,
      join(item.project, 'config/easignore.android'),
      item.scratch,
    );
    assert.equal(git(stage.root, ['rev-parse', 'HEAD']), git(item.source, ['rev-parse', 'HEAD']));
    assert.equal(
      git(stage.root, ['log', '-1', '--format=%B']),
      git(item.source, ['log', '-1', '--format=%B']),
    );
    assert.equal(git(stage.root, ['status', '--porcelain', '--untracked-files=all']), status);
    assert.equal(git(stage.root, ['show', ':openwhispr-mobile/source.txt']), 'staged change');
    for (const name of [
      'source.txt',
      'untracked.txt',
      'source-link',
      '.env.fixture',
      'node_modules/fixture.txt',
      'android/fixture.txt',
    ])
      assert.equal(
        await readFile(join(stage.root, 'openwhispr-mobile', name), 'utf8'),
        await readFile(join(item.project, name), 'utf8'),
      );
    await writeFile(join(stage.root, 'openwhispr-mobile/source.txt'), 'changed by staged CLI');
    assert.equal(await readFile(join(item.project, 'source.txt'), 'utf8'), 'working-tree change');
    assert.equal(git(item.source, ['status', '--porcelain', '--untracked-files=all']), status);
    assert(!existsSync(join(item.source, '.easignore')));
  } finally {
    await stage?.cleanup();
    assert.deepEqual(await readdir(item.scratch), []);
    await item.cleanup();
  }
});

test('preserves sparse and split indexes and an external Git directory', async () => {
  for (const variant of ['sparse-split', 'git-file']) {
    const item = await fixture();
    let stage;
    try {
      if (variant === 'sparse-split') {
        await mkdir(join(item.source, 'desktop'));
        await writeFile(join(item.source, 'desktop/fixture.txt'), 'excluded tracked source');
        git(item.source, ['add', 'desktop']);
        git(item.source, [
          '-c',
          'user.name=Archive fixture',
          '-c',
          'user.email=archive-fixture@example.invalid',
          'commit',
          '-m',
          'Sparse fixture',
        ]);
        git(item.source, ['sparse-checkout', 'set', 'openwhispr-mobile']);
        git(item.source, ['update-index', '--split-index']);
      } else {
        const metadata = join(item.folder, 'metadata');
        await rename(join(item.source, '.git'), metadata);
        await writeFile(join(item.source, '.git'), `gitdir: ${metadata}\n`);
        git(item.source, ['config', 'core.worktree', item.source]);
      }
      const status = git(item.source, ['status', '--porcelain', '--untracked-files=all']);
      stage = await stageAndroidArchive(
        item.source,
        join(item.project, 'config/easignore.android'),
        item.scratch,
      );
      assert.equal(git(stage.root, ['rev-parse', 'HEAD']), git(item.source, ['rev-parse', 'HEAD']));
      assert.equal(git(stage.root, ['status', '--porcelain', '--untracked-files=all']), status);
      assert.equal(git(item.source, ['status', '--porcelain', '--untracked-files=all']), status);
      if (variant === 'sparse-split') assert(!existsSync(join(stage.root, 'desktop/fixture.txt')));
    } finally {
      await stage?.cleanup();
      assert.deepEqual(await readdir(item.scratch), []);
      await item.cleanup();
    }
  }
});

test('rejects staging inside the source and cleans aborted or failed copies', async () => {
  const item = await fixture();
  try {
    const child = join(item.source, '..child'),
      alias = join(item.scratch, 'alias');
    await mkdir(child);
    await symlink(item.source, alias, 'dir');
    for (const parent of [item.source, item.project, child, alias])
      await assert.rejects(
        () =>
          stageAndroidArchive(item.source, join(item.project, 'config/easignore.android'), parent),
        /outside the source checkout/,
      );
    await rm(alias);
    await rm(child, { recursive: true });
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(
      () =>
        stageAndroidArchive(
          item.source,
          join(item.project, 'config/easignore.android'),
          item.scratch,
          abort.signal,
        ),
      { name: 'AbortError' },
    );
    await assert.rejects(
      () => stageAndroidArchive(item.source, join(item.folder, 'missing-ignore'), item.scratch),
      { code: 'ENOENT' },
    );
    assert.deepEqual(await readdir(item.scratch), []);
  } finally {
    await item.cleanup();
  }
});

test(
  'a missing CLI executable fails without leaving a stage',
  { skip: process.platform === 'win32' },
  async () => {
    const item = await fixture();
    try {
      const bin = join(item.folder, 'without-npx');
      await mkdir(bin);
      const actualGit = execFileSync('/bin/sh', ['-c', 'command -v git'], {
        encoding: 'utf8',
      }).trim();
      await symlink(actualGit, join(bin, 'git'));
      await symlink('/bin/sh', join(bin, 'sh'));
      const child = spawn(
        process.execPath,
        [join(item.project, 'scripts/eas-android.mjs'), 'build'],
        {
          cwd: item.folder,
          env: {
            ...process.env,
            PATH: bin,
            TMPDIR: item.scratch,
            TMP: item.scratch,
            TEMP: item.scratch,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let output = '';
      child.stdout.on('data', (data) => {
        output += data;
      });
      child.stderr.on('data', (data) => {
        output += data;
      });
      const code = await new Promise((resolveExit, reject) => {
        child.once('error', reject);
        child.once('close', resolveExit);
      });
      assert.equal(code, 1, output);
      assert.match(output, /spawn npx ENOENT/);
      assert.deepEqual(await readdir(item.scratch), []);
      assert(!existsSync(join(item.source, '.easignore')));
    } finally {
      await item.cleanup();
    }
  },
);

const fakeNpx = `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const argv=process.argv.slice(2),project=process.cwd(),root=process.env.EAS_PROJECT_ROOT;
const result={argv,project,root,head:cp.execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),dotenv:fs.readFileSync('.env.fixture','utf8'),dependency:fs.readFileSync('node_modules/fixture.txt','utf8'),native:fs.readFileSync('android/fixture.txt','utf8'),ignore:fs.existsSync(path.join(root,'.easignore')),artifacts:process.env.EAS_LOCAL_BUILD_ARTIFACTS_DIR,artifact:process.env.EAS_LOCAL_BUILD_ARTIFACT_PATH,working:process.env.EAS_LOCAL_BUILD_WORKINGDIR};
fs.writeFileSync('source.txt','staged CLI edit');fs.writeFileSync('node_modules/fixture.txt','staged dependency edit');
function report(){fs.writeFileSync(process.env.FIXTURE_REPORT,JSON.stringify(result));}
if(process.env.FIXTURE_MODE==='descendant'){
 const descendant=cp.spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});process.on('SIGINT',()=>{});process.send('ready');setInterval(()=>{},1000)"],{stdio:['ignore','ignore','ignore','ipc']});
 result.descendant=descendant.pid;descendant.once('message',report);setInterval(()=>{},1000);
}else if(process.env.FIXTURE_MODE==='stubborn'){process.on('SIGTERM',()=>{});report();setInterval(()=>{},1000);
}else{report();if(process.env.FIXTURE_MODE.startsWith('local')){const output=process.env.EAS_LOCAL_BUILD_ARTIFACT_PATH||path.join(process.env.EAS_LOCAL_BUILD_ARTIFACTS_DIR,'local.aab');fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,'synthetic local artifact');}const option=argv.indexOf('--output');if(option>=0)fs.writeFileSync(argv[option+1],'outside-stage artifact');process.exitCode=process.env.FIXTURE_MODE==='fail'?7:0;}
`;

async function startFixtureCli(item, mode, args, extraEnvironment = {}) {
  const bin = join(item.folder, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'npx'), fakeNpx, { mode: 0o755 });
  const report = join(item.folder, 'report.json');
  const child = spawn(process.execPath, [join(item.project, 'scripts/eas-android.mjs'), ...args], {
    cwd: item.folder,
    env: {
      ...process.env,
      TMPDIR: item.scratch,
      TMP: item.scratch,
      TEMP: item.scratch,
      PATH: bin + ':' + process.env.PATH,
      FIXTURE_MODE: mode,
      FIXTURE_REPORT: report,
      ...extraEnvironment,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (data) => {
    output += data;
  });
  child.stderr.on('data', (data) => {
    output += data;
  });
  const finished = new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolveExit({ code, signal, output }));
  });
  const ready = async () => {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      if (existsSync(report)) return JSON.parse(await readFile(report, 'utf8'));
      if (child.exitCode !== null) throw new Error(output);
      await pause(20);
    }
    throw new Error('Synthetic CLI did not become ready: ' + output);
  };
  return { child, finished, ready };
}

test(
  'CLI success and failure preserve arguments, local inputs and source, then clean the stage',
  { skip: process.platform === 'win32' },
  async () => {
    for (const mode of ['success', 'fail']) {
      const item = await fixture();
      try {
        const invocation = await startFixtureCli(item, mode, [
          'build:inspect',
          '--stage',
          'archive',
          '--profile',
          'android-play-test',
          '--output',
          'result file;$x',
        ]);
        const report = await invocation.ready(),
          result = await invocation.finished;
        assert.equal(result.code, mode === 'success' ? 0 : 7, result.output);
        assert.deepEqual(report.argv, [
          '--yes',
          'eas-cli@25.1.1',
          'build:inspect',
          '--stage',
          'archive',
          '--profile',
          'android-play-test',
          '--output',
          join(item.folder, 'result file;$x'),
          '--platform',
          'android',
        ]);
        assert.equal(report.head, git(item.source, ['rev-parse', 'HEAD']).trim());
        assert.equal(report.dotenv, 'synthetic dotenv');
        assert.equal(report.dependency, 'synthetic dependency');
        assert.equal(report.native, 'synthetic native state');
        assert(report.ignore);
        assert.equal(
          await readFile(join(item.folder, 'result file;$x'), 'utf8'),
          'outside-stage artifact',
        );
        assert.equal(await readFile(join(item.project, 'source.txt'), 'utf8'), 'fixture source');
        assert.equal(
          await readFile(join(item.project, 'node_modules/fixture.txt'), 'utf8'),
          'synthetic dependency',
        );
        assert(!existsSync(report.root));
        assert(!existsSync(join(item.source, '.easignore')));
        assert.deepEqual(await readdir(item.scratch), []);
      } finally {
        await item.cleanup();
      }
    }
  },
);

test(
  'SIGINT stops the CLI process group and removes the stage',
  { skip: process.platform === 'win32', timeout: 15000 },
  async () => {
    const item = await fixture();
    let invocation;
    try {
      invocation = await startFixtureCli(item, 'descendant', [
        'build',
        '--profile',
        'android-play-test',
      ]);
      const report = await invocation.ready();
      invocation.child.kill('SIGINT');
      const result = await invocation.finished;
      assert.equal(result.code, 130, result.output);
      for (let attempt = 0; attempt < 50; attempt += 1) {
        try {
          process.kill(report.descendant, 0);
          await pause(20);
        } catch (error) {
          if (error.code === 'ESRCH') break;
          throw error;
        }
      }
      assert.throws(() => process.kill(report.descendant, 0), {
        code: 'ESRCH',
      });
      assert(!existsSync(report.root));
      assert.deepEqual(await readdir(item.scratch), []);
    } finally {
      if (invocation?.child.exitCode === null) invocation.child.kill('SIGTERM');
      await item.cleanup();
    }
  },
);

test(
  'SIGTERM escalates a non-responsive CLI and removes the stage',
  { skip: process.platform === 'win32', timeout: 15000 },
  async () => {
    const item = await fixture();
    let invocation;
    try {
      invocation = await startFixtureCli(item, 'stubborn', [
        'build',
        '--profile',
        'android-play-test',
      ]);
      const report = await invocation.ready();
      invocation.child.kill('SIGTERM');
      const result = await invocation.finished;
      assert.equal(result.code, 143, result.output);
      assert(!existsSync(report.root));
      assert.deepEqual(await readdir(item.scratch), []);
    } finally {
      if (invocation?.child.exitCode === null) invocation.child.kill('SIGTERM');
      await item.cleanup();
    }
  },
);

test(
  'local-build artifacts and explicit local paths survive stage cleanup',
  { skip: process.platform === 'win32' },
  async () => {
    for (const custom of [false, true]) {
      const item = await fixture();
      try {
        const invocation = await startFixtureCli(item, 'local', ['build', '--local'], {
          EAS_LOCAL_BUILD_ARTIFACTS_DIR: custom ? 'artifacts' : '',
          EAS_LOCAL_BUILD_ARTIFACT_PATH: custom ? 'selected.aab' : '',
          EAS_LOCAL_BUILD_WORKINGDIR: custom ? 'native-work' : '',
        });
        const report = await invocation.ready(),
          result = await invocation.finished;
        assert.equal(result.code, 0, result.output);
        assert.equal(report.artifacts, custom ? join(item.folder, 'artifacts') : item.folder);
        if (custom) {
          assert.equal(report.artifact, join(item.folder, 'selected.aab'));
          assert.equal(report.working, join(item.folder, 'native-work'));
        }
        assert.equal(
          await readFile(join(item.folder, custom ? 'selected.aab' : 'local.aab'), 'utf8'),
          'synthetic local artifact',
        );
        assert.deepEqual(await readdir(item.scratch), []);
      } finally {
        await item.cleanup();
      }
    }
  },
);
