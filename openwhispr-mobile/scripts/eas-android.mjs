#!/usr/bin/env node

import { constants, existsSync } from 'node:fs';
import { cp, copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
  toNamespacedPath,
} from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const EAS_VERSION = '25.1.1';
const signalExitCodes = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };

const git = (root, args) =>
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

export function androidArguments(argv, callerDirectory) {
  const [command, ...args] = argv;
  if (!['build', 'build:inspect'].includes(command)) {
    throw new Error('Use build or build:inspect. This command always targets Android.');
  }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--' || arg === '-p' || arg === '--platform' || arg.startsWith('--platform=')) {
      throw new Error('Do not supply a platform; this command always targets Android.');
    }
    if (arg.startsWith('-') && !arg.startsWith('--') && arg.length > 2) {
      throw new Error('Use separate short options and values, or long options.');
    }
    if (arg === '--output' || arg === '-o') {
      if (!args[index + 1] || args[index + 1].startsWith('-')) {
        throw new Error('The output option requires a path.');
      }
      args[index + 1] = resolve(callerDirectory, args[index + 1]);
      index += 1;
    } else if (arg.startsWith('--output=')) {
      const value = arg.slice('--output='.length);
      if (!value) throw new Error('The output option requires a path.');
      args[index] = '--output=' + resolve(callerDirectory, value);
    }
  }
  return [command, ...args, '--platform', 'android'];
}

export async function stageAndroidArchive(sourceRoot, ignorePath, temporaryParent, signal) {
  sourceRoot = await realpath(sourceRoot);
  temporaryParent = await realpath(temporaryParent);
  const fromSource = relative(sourceRoot, temporaryParent);
  const outside =
    fromSource === '..' || fromSource.startsWith('..' + sep) || isAbsolute(fromSource);
  if (!outside) throw new Error('The staging directory must be outside the source checkout.');
  signal?.throwIfAborted();
  const parent = await mkdtemp(join(temporaryParent, 'android-eas-stage-'));
  const stagedRoot = join(parent, 'project');
  try {
    const sourceCommit = git(sourceRoot, ['rev-parse', 'HEAD']).trim();
    git(sourceRoot, [
      'clone',
      '--shared',
      '--no-checkout',
      '--single-branch',
      '--no-tags',
      sourceRoot,
      stagedRoot,
    ]);
    git(stagedRoot, ['config', 'core.hooksPath', '/dev/null']);
    git(stagedRoot, ['update-ref', '--no-deref', 'HEAD', sourceCommit]);
    signal?.throwIfAborted();
    // Keep local CLI inputs, including dependencies, dotenv and native-directory state.
    // The Android policy filters the later archive, rather than the CLI's project view.
    const copySource = toNamespacedPath(sourceRoot);
    await cp(copySource, stagedRoot, {
      recursive: true,
      verbatimSymlinks: true,
      mode: constants.COPYFILE_FICLONE,
      filter: (file) => {
        signal?.throwIfAborted();
        return file !== join(copySource, '.git');
      },
    });
    signal?.throwIfAborted();
    const index = git(sourceRoot, [
      'rev-parse',
      '--path-format=absolute',
      '--git-path',
      'index',
    ]).trim();
    await copyFile(index, join(stagedRoot, '.git/index'));
    const sharedIndex = git(sourceRoot, ['rev-parse', '--shared-index-path']).trim();
    if (sharedIndex) {
      const absolute = isAbsolute(sharedIndex) ? sharedIndex : resolve(sourceRoot, sharedIndex);
      await copyFile(absolute, join(stagedRoot, '.git', basename(absolute)));
    }
    const sourceExclude = git(sourceRoot, [
      'rev-parse',
      '--path-format=absolute',
      '--git-path',
      'info/exclude',
    ]).trim();
    let exclude = '';
    try {
      exclude = await readFile(sourceExclude, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const targetExclude = join(stagedRoot, '.git/info/exclude');
    await mkdir(dirname(targetExclude), { recursive: true });
    await writeFile(targetExclude, exclude + '\n/.easignore\n');
    await copyFile(ignorePath, join(stagedRoot, '.easignore'));
    signal?.throwIfAborted();
    if (git(sourceRoot, ['rev-parse', 'HEAD']).trim() !== sourceCommit) {
      throw new Error('The source commit changed while preparing the Android snapshot. Try again.');
    }
    return {
      root: stagedRoot,
      sourceCommit,
      cleanup: () => rm(parent, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(parent, { recursive: true, force: true });
    throw error;
  }
}

function stopChild(child, signal) {
  if (!child?.pid) return;
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        timeout: 10000,
      });
    } else {
      process.kill(-child.pid, signal);
    }
  } catch (error) {
    if (process.platform !== 'win32' && error.code !== 'ESRCH') throw error;
  }
}

function npxCommand(args) {
  if (process.platform !== 'win32') return ['npx', args];
  // Launch npm's JavaScript entry directly; passing user arguments through cmd.exe
  // would change quoting and interpretation of paths containing shell characters.
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    const entry = join(directory, 'node_modules/npm/bin/npx-cli.js');
    if (existsSync(join(directory, 'npx.cmd')) && existsSync(entry)) {
      return [process.execPath, [entry, ...args]];
    }
  }
  throw new Error('Cannot locate npm alongside npx.cmd. Install Node 24 with npm on PATH.');
}

export async function runAndroidEas(argv) {
  const callerDirectory = process.cwd();
  const args = androidArguments(argv, callerDirectory);
  const mobileRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const sourceRoot = git(mobileRoot, ['rev-parse', '--show-toplevel']).trim();
  const mobileRelative = relative(sourceRoot, mobileRoot);
  const controller = new AbortController();
  let interrupted;
  let child;
  let stage;
  let forceStop;
  let exitCode = 1;
  const handlers = Object.fromEntries(
    Object.keys(signalExitCodes).map((signal) => [
      signal,
      () => {
        if (interrupted) {
          stopChild(child, 'SIGKILL');
          return;
        }
        interrupted = signal;
        controller.abort();
        stopChild(child, signal);
        if (child) forceStop = setTimeout(() => stopChild(child, 'SIGKILL'), 5000);
      },
    ]),
  );
  for (const [signal, handler] of Object.entries(handlers)) process.on(signal, handler);
  try {
    stage = await stageAndroidArchive(
      sourceRoot,
      join(mobileRoot, 'config/easignore.android'),
      tmpdir(),
      controller.signal,
    );
    controller.signal.throwIfAborted();
    console.log(`Android build snapshot: ${stage.sourceCommit}`);
    const [executable, cliArgs] = npxCommand(['--yes', `eas-cli@${EAS_VERSION}`, ...args]);
    const environment = { ...process.env, EAS_PROJECT_ROOT: stage.root };
    for (const key of [
      'EAS_LOCAL_BUILD_WORKINGDIR',
      'EAS_LOCAL_BUILD_ARTIFACTS_DIR',
      'EAS_LOCAL_BUILD_ARTIFACT_PATH',
    ]) {
      if (environment[key]) environment[key] = resolve(callerDirectory, environment[key]);
    }
    if (
      args[0] === 'build' &&
      args.includes('--local') &&
      !environment.EAS_LOCAL_BUILD_ARTIFACTS_DIR
    ) {
      environment.EAS_LOCAL_BUILD_ARTIFACTS_DIR = callerDirectory;
    }
    exitCode = await new Promise((resolveExit, reject) => {
      child = spawn(executable, cliArgs, {
        cwd: join(stage.root, mobileRelative),
        env: environment,
        stdio: 'inherit',
        detached: process.platform !== 'win32',
      });
      child.once('error', reject);
      child.once('close', (code, signal) => resolveExit(code ?? signalExitCodes[signal] ?? 1));
    });
  } catch (error) {
    if (!interrupted) throw error;
  } finally {
    clearTimeout(forceStop);
    if (interrupted) stopChild(child, 'SIGKILL');
    try {
      await stage?.cleanup();
    } finally {
      clearTimeout(forceStop);
      for (const [signal, handler] of Object.entries(handlers))
        process.removeListener(signal, handler);
    }
  }
  return interrupted ? signalExitCodes[interrupted] : exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runAndroidEas(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
