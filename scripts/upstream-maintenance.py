#!/usr/bin/env python3
"""Trusted helper for the OpenWhispr upstream-maintenance workflow.

Commands (all fail closed: exit 1 with "error: ..." on stderr, nothing on stdout):

  prepare        --repo DIR --output JSON [--base SHA]
  export-upstream --repo DIR --context JSON --output DIR [--only-attention REPORT]
  check-result   --repo DIR --context JSON --result JSON
  apply-selected --repo DIR --context JSON --result JSON --report JSON
  protected-paths --repo DIR --base SHA --output DIR
  guard          --repo DIR --base SHA
  candidate      --repo DIR --context JSON --result JSON --patch PATH [--editor-result JSON]
  check-patch    --repo DIR --base SHA --patch PATH --context JSON [--expect-tree SHA]
  publish        --repo DIR --context JSON --patch PATH --tree SHA [--remote NAME]

Flow: Claude classifies the whole upstream range (selected/skipped, read-only tools);
apply-selected applies the selected commits with Git three-way merges, never writing
protected paths; only commits that conflict or touch protected configuration are handed
to a conflict editor, whose result is validated by candidate against a fresh recomputation.

Run this from a trusted checkout, never from the repository being maintained.
Only the Python standard library, git and gh are used; no shell strings.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tempfile

UPSTREAM_REPO = 'OpenWhispr/openwhispr'
UPSTREAM_URL = 'https://github.com/OpenWhispr/openwhispr.git'
INITIAL_UPSTREAM = '7a6ae826de9ec1caf65f3a6e769475dab2ae829f'
PERSONAL_BRANCH = 'feat/byok-cleanup'
GH_COMMAND = ['gh']
STATE_PATH = '.github/upstream-maintenance-state.json'
POLICY_PATH = '.github/personal-fork-policy.json'
UPSTREAM_REF = 'refs/upstream-maintenance/release'
COMMIT_AUTHOR = ('github-actions[bot]', '41898282+github-actions[bot]@users.noreply.github.com')

SHA_RE = re.compile(r'^[0-9a-f]{40}$')
TAG_RE = re.compile(r'^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$')
REMOTE_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]*$')

PROTECTED_FILES = {
    'fork.md': 'FORK.md is the owner contract',
    'claude.md': 'CLAUDE.md is an instruction file',
    '.gitmodules': 'submodule configuration',
    'scripts/upstream-maintenance.py': 'trusted maintenance helper',
    'scripts/verify-personal-fork.cjs': 'fork verification script',
    'scripts/check-maintenance-tests.py': 'maintenance test checker',
    '.npmrc': 'package execution configuration',
    'eslint.config.js': 'verification configuration',
    'src/eslint.config.js': 'verification configuration',
    'src/tsconfig.json': 'verification configuration',
    'src/vite.config.mjs': 'verification configuration',
}
PROTECTED_PREFIXES = {
    'test/lib/': 'shared protected-test harnesses',
    'test/helpers/harness/': 'shared protected-test harnesses',
    '.github/': 'workflows, policy and state are not agent-editable',
    'test/maintenance/': 'maintenance tests',
}
# Added, modified or deleted anywhere in the tree: instructions, settings, hooks, git behaviour.
INSTRUCTION_NAMES = {'claude.md', 'claude.local.md', 'agents.md', 'gemini.md', '.hermes.md',
                     '.cursorrules', '.windsurfrules', '.clinerules', 'copilot-instructions.md',
                     '.mcp.json', '.claude.json', '.gitattributes', '.gitmodules'}
INSTRUCTION_DIRS = {'.claude', '.cursor', '.windsurf', '.clinerules', '.agents', '.hermes',
                    '.husky', '.githooks'}
# package.json commands the verifier runs; they must stay byte-identical to the trusted base.
# pre/post hooks of these run implicitly; install-time lifecycle scripts run under `npm ci`.
REQUIRED_SCRIPTS = ('typecheck', 'lint', 'build:renderer', 'test')
INSTALL_LIFECYCLE = ('preinstall', 'install', 'postinstall', 'prepare', 'preprepare', 'postprepare')
PINNED_SCRIPTS = (REQUIRED_SCRIPTS + INSTALL_LIFECYCLE
                  + tuple('pre' + n for n in REQUIRED_SCRIPTS) + tuple('post' + n for n in REQUIRED_SCRIPTS))


class MaintenanceError(Exception):
    pass


def fail(message):
    raise MaintenanceError(message)


# ---------------------------------------------------------------- git plumbing

GIT_BASE = ['git', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=' + os.devnull,
            '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false',
            '-c', 'core.untrackedCache=false', '-c', 'core.quotePath=false',
            '-c', 'diff.renames=false']


def git_env(extra=None):
    env = {k: v for k, v in os.environ.items() if not k.startswith('GIT_')}
    env.update(GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=os.devnull,
               GIT_TERMINAL_PROMPT='0', GIT_OPTIONAL_LOCKS='0', LC_ALL='C')
    env.update(extra or {})
    return env


def git_try(repo, *args, input=None, env=None, timeout=600):
    """Run git in repo with a fixed argument vector; return the CompletedProcess."""
    cmd = GIT_BASE + ['-C', str(repo)] + list(args)
    try:
        return subprocess.run(cmd, input=input, capture_output=True, env=git_env(env), timeout=timeout)
    except (OSError, subprocess.TimeoutExpired) as e:
        raise MaintenanceError('git %s failed: %s' % (args[0], e))


def git(repo, *args, input=None, env=None):
    """Like git_try but raises on failure and returns stdout bytes."""
    p = git_try(repo, *args, input=input, env=env)
    if p.returncode:
        fail('git %s failed: %s' % (' '.join(args[:2]), p.stderr.decode(errors='replace').strip()))
    return p.stdout


def git_text(repo, *args, **kw):
    return git(repo, *args, **kw).decode('utf-8', 'replace').strip()


def open_repo(path):
    p = Path(path)
    if not p.is_dir():
        fail('repository path is not a directory: %s' % path)
    real = Path(os.path.realpath(p))
    top = git_text(real, 'rev-parse', '--show-toplevel')
    if Path(os.path.realpath(top)) != real:
        fail('%s is not the top level of a git repository' % path)
    return real


def outside_repo(repo, path):
    resolved = Path(os.path.realpath(path))
    if resolved == repo or repo in resolved.parents:
        fail('%s must be outside the repository' % path)
    return resolved


def as_sha(value, label):
    if not isinstance(value, str) or not SHA_RE.match(value):
        fail('%s must be a 40-character lowercase hex commit id' % label)
    return value


def reject_duplicate_keys(pairs):
    keys = [k for k, _ in pairs]
    if len(keys) != len(set(keys)):
        fail('duplicate key in JSON object')
    return dict(pairs)


def read_json(path, label):
    try:
        return json.loads(Path(path).read_text(encoding='utf-8'), object_pairs_hook=reject_duplicate_keys)
    except (OSError, ValueError) as e:
        fail('cannot read %s: %s' % (label, e))


def require_head(repo, base):
    as_sha(base, 'base')
    if git_try(repo, 'rev-parse', '--verify', '--quiet', base + '^{commit}').returncode:
        fail('base commit %s does not exist in the repository' % base)
    head = git_text(repo, 'rev-parse', 'HEAD')
    if head != base:
        fail('stale base: HEAD is %s but the run is pinned to %s' % (head, base))


# ------------------------------------------------------------ work tree capture

def valid_name(name):
    try:
        name.encode('utf-8')
    except UnicodeEncodeError:
        return False
    return not any(ord(c) < 32 or ord(c) == 127 or c == '"' for c in name)


def scan_worktree(repo):
    """Every path in the work tree regardless of ignore rules (node_modules excluded)."""
    files, links = [], []

    def walk(directory, prefix):
        with os.scandir(directory) as it:
            entries = sorted(it, key=lambda e: e.name)
        for entry in entries:
            name = entry.name
            if not valid_name(name):
                fail('unsupported file name in work tree: %r' % (prefix + name))
            if name == '.git':
                if prefix == '':
                    continue
                fail('nested git metadata at %s' % (prefix + name))
            if name == 'node_modules':
                continue
            rel = prefix + name
            mode = entry.stat(follow_symlinks=False).st_mode
            if stat.S_ISLNK(mode):
                links.append(rel)
            elif stat.S_ISDIR(mode):
                walk(entry.path, rel + '/')
            elif stat.S_ISREG(mode):
                files.append((rel, bool(mode & 0o111)))
            else:
                fail('special file in work tree: %s' % rel)
    walk(str(repo), '')
    return files, links


def reject_ignored(repo):
    out = git(repo, 'ls-files', '-z', '--others', '--ignored', '--exclude-standard')
    bad = [p.decode('utf-8', 'replace') for p in out.split(b'\0')
           if p and b'node_modules' not in p.split(b'/')]
    if bad:
        fail('ignored files would be missing from the patch (only node_modules is allowed): '
             + ', '.join(sorted(bad)[:10]))


def worktree_tree(repo):
    """Write the full work tree (not the index) into the object store and return its tree id."""
    reject_ignored(repo)
    files, links = scan_worktree(repo)
    entries = []
    if files:
        listing = ''.join(rel + '\n' for rel, _ in files).encode('utf-8')
        shas = git_text(repo, 'hash-object', '-w', '--no-filters', '--stdin-paths', input=listing).split('\n')
        if len(shas) != len(files):
            fail('unexpected hash-object output')
        entries += [('100755' if ex else '100644', sha, rel) for (rel, ex), sha in zip(files, shas)]
    for rel in links:
        target = os.readlink(os.path.join(str(repo), rel))
        sha = git_text(repo, 'hash-object', '-w', '--no-filters', '--stdin', input=os.fsencode(target))
        entries.append(('120000', sha, rel))
    scratch = tempfile.mkdtemp(prefix='um-index-')
    try:
        env = {'GIT_INDEX_FILE': os.path.join(scratch, 'index')}
        data = b''.join(('%s %s\t%s' % e).encode('utf-8') + b'\0' for e in entries)
        git(repo, 'update-index', '--add', '-z', '--index-info', input=data, env=env)
        return git_text(repo, 'write-tree', env=env)
    finally:
        shutil.rmtree(scratch, ignore_errors=True)


def tree_changes(repo, old_tree, new_tree):
    raw = git(repo, 'diff-tree', '-r', '-z', '--raw', '--no-renames', '--no-abbrev', old_tree, new_tree)
    tokens = raw.split(b'\0')
    changes, i = [], 0
    while i + 1 < len(tokens) and tokens[i].startswith(b':'):
        old_mode, new_mode, old_sha, new_sha, status = tokens[i][1:].decode().split()
        changes.append({'status': status[0], 'old_mode': old_mode, 'new_mode': new_mode,
                        'new_sha': new_sha, 'path': tokens[i + 1].decode('utf-8', 'replace')})
        i += 2
    return changes


# --------------------------------------------------------------- JSON schemas

def check_partition(selected, skipped, commits):
    shas = [c['sha'] for c in commits]
    claimed = list(selected) + list(skipped)
    if len(claimed) != len(set(claimed)):
        fail('a commit appears more than once in selected/skipped')
    missing, unknown = set(shas) - set(claimed), set(claimed) - set(shas)
    if missing or unknown:
        fail('selected+skipped must exactly partition the pending commits '
             '(missing: %s; unexpected: %s)' % (sorted(missing) or 'none', sorted(unknown) or 'none'))


def parse_decisions(selected, skipped, label):
    if not isinstance(selected, list):
        fail('%s.selected must be a list' % label)
    for sha in selected:
        as_sha(sha, label + '.selected entry')
    if not isinstance(skipped, list):
        fail('%s.skipped must be a list' % label)
    reasons = {}
    for item in skipped:
        if not isinstance(item, dict) or set(item) != {'sha', 'reason'}:
            fail('%s.skipped entries must be exactly {sha, reason}' % label)
        as_sha(item['sha'], label + '.skipped sha')
        if not isinstance(item['reason'], str) or not item['reason'].strip() or len(item['reason']) > 4000:
            fail('%s.skipped reason must be a non-empty string' % label)
        if item['sha'] in reasons:
            fail('a commit appears more than once in selected/skipped')
        reasons[item['sha']] = item['reason']
    return reasons


def validate_context(ctx):
    keys = {'base_sha', 'release_tag', 'upstream_sha', 'previous_upstream', 'commits', 'pending'}
    if not isinstance(ctx, dict) or set(ctx) != keys:
        fail('context must be an object with exactly: ' + ', '.join(sorted(keys)))
    for key in ('base_sha', 'upstream_sha', 'previous_upstream'):
        as_sha(ctx[key], 'context.' + key)
    if not isinstance(ctx['release_tag'], str) or not TAG_RE.match(ctx['release_tag']):
        fail('context.release_tag is not a stable release tag')
    if not isinstance(ctx['commits'], list) or not isinstance(ctx['pending'], bool):
        fail('context.commits must be a list and context.pending a boolean')
    seen = set()
    for c in ctx['commits']:
        if not isinstance(c, dict) or set(c) != {'sha', 'subject'} or not isinstance(c['subject'], str):
            fail('context.commits entries must be exactly {sha, subject}')
        as_sha(c['sha'], 'context commit')
        if c['sha'] in seen:
            fail('duplicate commit in context')
        seen.add(c['sha'])
    if ctx['pending'] != bool(ctx['commits']):
        fail('context.pending disagrees with context.commits')
    return ctx


def load_context(path):
    return validate_context(read_json(path, 'context'))


STATE_KEYS = {'reviewed_upstream', 'release_tag', 'base_sha', 'selected', 'skipped'}


def validate_state(state, ctx=None):
    if not isinstance(state, dict) or set(state) != STATE_KEYS:
        fail('state must be an object with exactly: ' + ', '.join(sorted(STATE_KEYS)))
    as_sha(state['reviewed_upstream'], 'state.reviewed_upstream')
    as_sha(state['base_sha'], 'state.base_sha')
    if not isinstance(state['release_tag'], str) or not TAG_RE.match(state['release_tag']):
        fail('state.release_tag is not a stable release tag')
    reasons = parse_decisions(state['selected'], state['skipped'], 'state')
    if ctx is not None:
        if state['reviewed_upstream'] != ctx['upstream_sha']:
            fail('state.reviewed_upstream does not match the release under review')
        if state['release_tag'] != ctx['release_tag']:
            fail('state.release_tag does not match the release under review')
        if state['base_sha'] != ctx['base_sha']:
            fail('state.base_sha does not match the pinned base')
        check_partition(state['selected'], list(reasons), ctx['commits'])
    return state


def canonical_state(state):
    return (json.dumps(state, indent=2, sort_keys=True) + '\n').encode('utf-8')


def parse_result(path, ctx):
    data = read_json(path, 'result')
    keys = {'complete', 'selected', 'skipped', 'summary'}
    if not isinstance(data, dict) or set(data) != keys:
        fail('result must be an object with exactly: ' + ', '.join(sorted(keys)))
    if not isinstance(data['complete'], bool):
        fail('result.complete must be a boolean')
    if not data['complete']:
        fail('agent reported the review as incomplete')
    if not isinstance(data['summary'], str) or not data['summary'].strip() or len(data['summary']) > 20000:
        fail('result.summary must be a non-empty string')
    reasons = parse_decisions(data['selected'], data['skipped'], 'result')
    check_partition(data['selected'], list(reasons), ctx['commits'])
    chosen = set(data['selected'])
    order = [c['sha'] for c in ctx['commits']]
    return ([s for s in order if s in chosen],
            [{'sha': s, 'reason': reasons[s]} for s in order if s in reasons])


# -------------------------------------------------------------------- the guard

def load_policy_tests(repo, base, fold=True):
    p = git_try(repo, 'cat-file', 'blob', '%s:%s' % (base, POLICY_PATH))
    if p.returncode:
        fail('fork policy %s is missing at the base commit' % POLICY_PATH)
    try:
        policy = json.loads(p.stdout.decode('utf-8'))
    except ValueError as e:
        fail('fork policy is not valid JSON: %s' % e)
    tests = policy.get('protected_tests') if isinstance(policy, dict) else None
    if not isinstance(tests, list):
        fail('fork policy protected_tests must be a list')
    out = []
    for t in tests:
        if not isinstance(t, str) or not t or t.startswith('/') or '..' in t.split('/'):
            fail('fork policy has an invalid protected test path: %r' % (t,))
        out.append(t.casefold() if fold else t)
    return out


def is_test_path(path):
    parts = path.casefold().split('/')
    name = parts[-1]
    return (parts[0] in ('test', 'tests') or any(p in ('test', 'tests', '__tests__') for p in parts[:-1])
            or re.search(r'\.(test|spec)\.[^/]+$', name) is not None
            or (name.startswith('test_') and name.endswith('.py')) or name.endswith('_test.py'))


def protection_reason(path, protected_tests):
    key = path.casefold()
    if key in PROTECTED_FILES:
        return PROTECTED_FILES[key]
    if key == '.github' or key == 'test/maintenance':
        return 'protected directory'
    for prefix, why in PROTECTED_PREFIXES.items():
        if key.startswith(prefix):
            return why
    for t in protected_tests:
        if key == t or (t.endswith('/') and key.startswith(t)):
            return 'protected fork test'
    parts = key.split('/')
    if parts[-1] in INSTRUCTION_NAMES or any(p in INSTRUCTION_DIRS for p in parts):
        return 'agent instruction, settings, hook or git-behaviour file'
    return None


def package_problem(repo, base, tree):
    """package.json name and verifier commands must equal the trusted base exactly."""
    def load(rev):
        p = git_try(repo, 'cat-file', 'blob', '%s:package.json' % rev)
        if p.returncode:
            return None
        try:
            data = json.loads(p.stdout.decode('utf-8'), object_pairs_hook=reject_duplicate_keys)
        except (ValueError, MaintenanceError):
            return None
        return data if isinstance(data, dict) else None
    old, new = load(base), load(tree)
    if old is None:
        fail('package.json at the base commit is missing or invalid')
    if new is None:
        return 'package.json is missing, deleted or not a valid JSON object'
    if new.get('name') != old.get('name'):
        return 'package.json name must not change'
    old_scripts, new_scripts = old.get('scripts', {}), new.get('scripts', {})
    if not isinstance(old_scripts, dict) or not isinstance(new_scripts, dict):
        return 'package.json scripts must be an object'
    for name in PINNED_SCRIPTS:
        if (name in old_scripts) != (name in new_scripts) or old_scripts.get(name) != new_scripts.get(name):
            return 'package.json script %r must stay identical to the trusted base' % name
    return None


def state_problem(repo, change, ctx):
    if change['status'] not in ('A', 'M') or change['new_mode'] != '100644':
        return 'state file must be an added or modified regular file'
    blob = git(repo, 'cat-file', 'blob', change['new_sha'])
    try:
        state = json.loads(blob.decode('utf-8'), object_pairs_hook=reject_duplicate_keys)
        validate_state(state, ctx)
    except (ValueError, MaintenanceError) as e:
        return 'invalid state file: %s' % e
    if blob != canonical_state(state):
        return 'state file is not in canonical form'
    return None


def guard_tree(repo, base, ctx=None):
    """Return the work-tree id if nothing forbidden changed relative to base, else raise.

    The comparison is work tree vs base commit, so commits made by the agent are caught too.
    With ctx, the trusted state file must be present, valid and the only .github change.
    """
    as_sha(base, 'base')
    if git_try(repo, 'rev-parse', '--verify', '--quiet', base + '^{commit}').returncode:
        fail('base commit %s does not exist in the repository' % base)
    protected_tests = load_policy_tests(repo, base)
    tree = worktree_tree(repo)
    problems, state_seen = [], False
    changes = tree_changes(repo, base + '^{tree}', tree)
    for ch in changes:
        path = ch['path']
        if path == STATE_PATH:
            if ctx is None:
                problems.append('%s: only the trusted finalize step may write the state file' % path)
            else:
                state_seen = True
                why = state_problem(repo, ch, ctx)
                if why:
                    problems.append('%s: %s' % (path, why))
            continue
        why = protection_reason(path, protected_tests)
        if why:
            problems.append('%s: protected path (%s)' % (path, why))
        elif '120000' in (ch['old_mode'], ch['new_mode']):
            problems.append('%s: symlinks may not be added, changed or removed' % path)
        elif '160000' in (ch['old_mode'], ch['new_mode']):
            problems.append('%s: submodules/gitlinks are not allowed' % path)
        elif ch['status'] in ('D', 'T') and is_test_path(path):
            problems.append('%s: existing tests may not be deleted' % path)
    if any(ch['path'] == 'package.json' for ch in changes):
        why = package_problem(repo, base, tree)
        if why:
            problems.append('package.json: ' + why)
    if ctx is not None and not state_seen:
        problems.append('%s: state file was not updated' % STATE_PATH)
    if problems:
        fail('guard rejected the change:\n  ' + '\n  '.join(problems))
    return tree


# ------------------------------------------------- mechanical application of picks

# Git metadata an editing agent could use to make later trusted Git commands run code or
# change what they read. The editor has no shell and is denied .git, so this is a second layer.
RISKY_CONFIG = re.compile(
    r'^(include\.|includeif\.|filter\.|alias\.|merge\..*\.(driver|name)$|diff\..*\.(command|textconv)$'
    r'|core\.(fsmonitor|hookspath|attributesfile|worktree)$)')
ATTENTION_IGNORED_NAMES = ('fork.md', 'claude.md', '.gitmodules')


def check_git_metadata(repo):
    git_dir = repo / '.git'
    if git_dir.is_symlink() or not git_dir.is_dir():
        fail('.git must be a real directory')
    attributes = git_dir / 'info' / 'attributes'
    if attributes.exists() and attributes.stat().st_size:
        fail('.git/info/attributes must not be used')
    hooks = git_dir / 'hooks'
    if hooks.is_dir():
        for entry in hooks.iterdir():
            if not entry.name.endswith('.sample'):
                fail('unexpected Git hook %s' % entry.name)
    p = git_try(repo, 'config', '--local', '--list', '-z')
    if p.returncode:
        fail('cannot read local Git configuration')
    for record in p.stdout.decode('utf-8', 'replace').split('\0'):
        key = record.partition('\n')[0].casefold()
        if key and RISKY_CONFIG.match(key):
            fail('local Git configuration key %s is not allowed' % key)


def needs_adaptation(path):
    """True when a dropped protected change may leave other code needing an adaptation."""
    key = path.casefold()
    if key.startswith('.github/') or key in ATTENTION_IGNORED_NAMES:
        return False
    parts = key.split('/')
    return not (parts[-1] in INSTRUCTION_NAMES or any(p in INSTRUCTION_DIRS for p in parts))


def tree_entries(repo, tree):
    entries = {}
    for record in git(repo, 'ls-tree', '-r', '-z', '--full-tree', tree).split(b'\0'):
        if record:
            meta, _, path = record.partition(b'\t')
            mode, _, sha = meta.decode().split()
            entries[path.decode('utf-8', 'replace')] = (mode, sha)
    return entries


def set_paths(repo, tree, source_entries, paths):
    """Return tree with each path reset to its entry in source_entries (removed if absent)."""
    if not paths:
        return tree
    scratch = tempfile.mkdtemp(prefix='um-index-')
    try:
        env = {'GIT_INDEX_FILE': os.path.join(scratch, 'index')}
        git(repo, 'read-tree', tree, env=env)
        data = b''
        for path in sorted(paths):
            mode, sha = source_entries.get(path, ('0', '0' * 40))
            data += ('%s %s\t%s' % (mode, sha, path)).encode('utf-8') + b'\0'
        git(repo, 'update-index', '-z', '--index-info', input=data, env=env)
        return git_text(repo, 'write-tree', env=env)
    finally:
        shutil.rmtree(scratch, ignore_errors=True)


def commit_paths(repo, parent, sha):
    raw = git(repo, 'diff-tree', '-r', '-z', '--name-only', '--no-renames', '--no-commit-id', parent, sha)
    return [p.decode('utf-8', 'replace') for p in raw.split(b'\0') if p]


def merge_pick(repo, ours, sha, parent):
    """Three-way merge of upstream commit sha (relative to parent) onto the ours commit."""
    # GIT_BASE turns diff.renames off; merges still need rename detection to follow fork renames.
    p = git_try(repo, '-c', 'merge.renames=true', 'merge-tree', '--write-tree', '-z', '--name-only', '--no-messages',
                '--merge-base=' + parent, ours, sha)
    if p.returncode not in (0, 1):
        fail('git merge-tree failed for %s: %s' % (sha, p.stderr.decode(errors='replace').strip()))
    tokens = p.stdout.split(b'\0')
    tree = tokens[0].decode()
    if not SHA_RE.match(tree):
        fail('unexpected merge-tree output for %s' % sha)
    conflicts = {t.decode('utf-8', 'replace') for t in tokens[1:] if t} if p.returncode else set()
    return tree, conflicts


def mechanical_plan(repo, ctx, selected):
    """Apply each selected upstream commit in order with a Git three-way merge.

    Pure function of the object database: it never reads the work tree, so it can be recomputed
    after an agent has edited it. Protected paths, symlinks, gitlinks, deleted tests and package.json
    scripts are never taken from upstream; what could not be applied is reported per commit.
    """
    base = ctx['base_sha']
    protected_tests = load_policy_tests(repo, base)
    name, email = COMMIT_AUTHOR
    ident = {'GIT_AUTHOR_NAME': name, 'GIT_AUTHOR_EMAIL': email,
             'GIT_COMMITTER_NAME': name, 'GIT_COMMITTER_EMAIL': email,
             'GIT_AUTHOR_DATE': '2000-01-01T00:00:00Z', 'GIT_COMMITTER_DATE': '2000-01-01T00:00:00Z'}
    ours = base
    ours_tree = git_text(repo, 'rev-parse', base + '^{tree}')
    commits = []
    for sha in selected:
        entry = {'sha': sha, 'status': 'applied', 'applied': [], 'conflicts': [], 'protected': [],
                 'kept_tests': [], 'guard': [], 'guard_paths': []}
        commits.append(entry)
        parents = git_text(repo, 'rev-list', '--parents', '-n', '1', sha).split()
        if len(parents) != 2:
            entry.update(status='unapplied', guard=['merge or root commit cannot be applied mechanically'])
            continue
        merged, conflicted = merge_pick(repo, ours, sha, parents[1])
        touched = set(commit_paths(repo, parents[1], sha))
        revert, conflicts = set(), set()
        changes = tree_changes(repo, ours_tree, merged)
        for ch in changes:
            path = ch['path']
            if protection_reason(path, protected_tests):
                entry['protected'].append(path)
                revert.add(path)
            elif path in conflicted or (conflicted and path not in touched):
                conflicts.add(path)
                revert.add(path)
            elif '120000' in (ch['old_mode'], ch['new_mode']) or '160000' in (ch['old_mode'], ch['new_mode']):
                entry['guard'].append('%s: symlinks and submodules are not applied' % path)
                entry['guard_paths'].append(path)
                revert.add(path)
            elif ch['status'] in ('D', 'T') and is_test_path(path):
                entry['kept_tests'].append(path)
                revert.add(path)
        for path in conflicted:
            if not protection_reason(path, protected_tests):
                conflicts.add(path)
        source = tree_entries(repo, ours_tree)
        result = set_paths(repo, merged, source, revert)
        if any(ch['path'] == 'package.json' and ch['path'] not in revert for ch in changes):
            why = package_problem(repo, base, result)
            if why:
                for path in ('package.json', 'package-lock.json'):
                    if any(ch['path'] == path for ch in changes):
                        revert.add(path)
                        entry['guard_paths'].append(path)
                entry['guard'].append('package.json: ' + why + '; package manifest and lockfile left unchanged')
                result = set_paths(repo, merged, source, revert)
        entry['applied'] = sorted(ch['path'] for ch in changes if ch['path'] not in revert)
        entry['conflicts'] = sorted(conflicts)
        entry['protected'] = sorted(set(entry['protected']))
        entry['kept_tests'] = sorted(entry['kept_tests'])
        if conflicts or entry['guard']:
            entry['status'] = 'partial' if entry['applied'] else 'unapplied'
        ours = git_text(repo, 'commit-tree', result, '-p', ours, input=('mechanical %s\n' % sha).encode(), env=ident)
        ours_tree = result
    return {'base_sha': base, 'tree': ours_tree, 'commits': commits}


def attention_shas(plan):
    return [c['sha'] for c in plan['commits']
            if c['status'] != 'applied' or any(needs_adaptation(p) for p in c['protected'])]


def materialize(repo, base_tree, tree):
    """Write the planned tree into the clean work tree without Git filters."""
    changes = tree_changes(repo, base_tree, tree)
    for ch in changes:
        if ch['status'] == 'D':
            target = Path(repo) / ch['path']
            if target.is_symlink() or target.is_file():
                target.unlink()
    for ch in changes:
        if ch['status'] == 'D':
            continue
        target = Path(repo) / ch['path']
        if ch['new_mode'] not in ('100644', '100755'):
            fail('%s: unsupported file mode %s in the planned tree' % (ch['path'], ch['new_mode']))
        for parent in reversed(target.parents):
            if parent == Path(repo) or repo not in parent.parents:
                continue
            if parent.is_file() or parent.is_symlink():
                parent.unlink()
        if target.is_dir() and not target.is_symlink():
            shutil.rmtree(target)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(git(repo, 'cat-file', 'blob', ch['new_sha']))
        target.chmod(0o755 if ch['new_mode'] == '100755' else 0o644)


def parse_editor_result(path, plan, attention, ctx, selected, skipped):
    """Validate the conflict editor's answer and return the final (selected, skipped)."""
    if not attention:
        if path is not None:
            fail('a conflict-editor result was supplied but no commit needs the editor')
        return selected, skipped
    if path is None:
        fail('commits need the conflict editor (%d) but no editor result was supplied' % len(attention))
    data = read_json(path, 'editor result')
    keys = {'complete', 'resolved', 'skipped', 'summary'}
    if not isinstance(data, dict) or set(data) != keys:
        fail('editor result must be an object with exactly: ' + ', '.join(sorted(keys)))
    if not isinstance(data['complete'], bool) or not data['complete']:
        fail('the conflict editor reported the work as incomplete')
    if not isinstance(data['summary'], str) or not data['summary'].strip() or len(data['summary']) > 20000:
        fail('editor result.summary must be a non-empty string')
    reasons = parse_decisions(data['resolved'], data['skipped'], 'editor result')
    resolved = list(data['resolved'])
    if len(resolved) != len(set(resolved)) or set(resolved) & set(reasons):
        fail('a commit appears more than once in the editor result')
    if set(resolved) | set(reasons) != set(attention):
        fail('the editor result must account for exactly the commits that needed it '
             '(missing: %s; unexpected: %s)' % (sorted(set(attention) - set(resolved) - set(reasons)) or 'none',
                                              sorted((set(resolved) | set(reasons)) - set(attention)) or 'none'))
    by_sha = {c['sha']: c for c in plan['commits']}
    for sha in reasons:
        if by_sha[sha]['status'] != 'unapplied':
            fail('commit %s was partly applied and cannot be skipped by the conflict editor' % sha)
    order = [c['sha'] for c in ctx['commits']]
    final_selected = [s for s in selected if s not in reasons]
    merged = {item['sha']: item['reason'] for item in skipped}
    merged.update({s: 'conflict editor: ' + r for s, r in reasons.items()})
    return final_selected, [{'sha': s, 'reason': merged[s]} for s in order if s in merged]


# ------------------------------------------------------------ agent-facing exports

EXPORT_EXCLUDES = (':(exclude)package-lock.json', ':(exclude)openwhispr-mobile', ':(exclude)src/locales')
DENY_NAME = re.compile(r'^[A-Za-z0-9._][A-Za-z0-9._/-]*$')


def numstat(repo, sha):
    raw = git(repo, 'show', '--format=', '--numstat', '-z', '--no-renames', sha).decode('utf-8', 'replace')
    rows = []
    for record in filter(None, raw.split('\0')):
        ins, _, rest = record.partition('\t')
        dele, _, path = rest.partition('\t')
        rows.append((ins, dele, path))
    return rows


def export_commit(repo, sha, max_bytes, paths=None):
    head = git(repo, 'show', '--format=fuller', '--no-patch', sha).decode('utf-8', 'replace')
    # Literal pathspecs: names come from upstream and must not be interpreted as globs or magic.
    pathspec = ['--'] + [':(literal)' + p for p in paths] if paths else ['--', '.'] + list(EXPORT_EXCLUDES)
    patch = git(repo, 'show', '--format=', '--patch', '--no-ext-diff', '--no-textconv', '--no-renames',
                sha, *pathspec)
    rows = numstat(repo, sha)
    stat = ''.join('%6s %6s  %s\n' % r for r in rows)
    body = patch[:max_bytes].decode('utf-8', 'replace')
    note = ''
    if len(patch) > max_bytes:
        note = '\n[patch truncated: %d bytes omitted]\n' % (len(patch) - max_bytes)
    scope = ('only the paths the trusted applier could not apply or had to leave out' if paths else
             'package-lock.json, openwhispr-mobile/ and src/locales/ diffs omitted; see FILES')
    text = ('%s\nFILES (added deleted path); binary shows "-":\n%s\nPATCH (%s):\n%s%s'
            % (head, stat, scope, body, note))
    return text, rows


def cmd_export_upstream(args):
    repo = open_repo(args.repo)
    output = outside_repo(repo, args.output)
    ctx = load_context(args.context)
    verify_context_commits(repo, ctx)
    shas = [c['sha'] for c in ctx['commits']]
    focus = {}
    if args.only_attention:
        report = read_json(args.only_attention, 'apply report')
        wanted = report.get('attention') if isinstance(report, dict) else None
        if not isinstance(wanted, list) or not all(isinstance(s, str) for s in wanted):
            fail('apply report has no attention list')
        unknown = set(wanted) - set(shas)
        if unknown:
            fail('apply report names commits outside the context')
        shas = [s for s in shas if s in set(wanted)]
        for entry in report.get('commits', []):
            if entry.get('sha') in wanted and entry.get('applied'):
                focus[entry['sha']] = sorted(set(entry['conflicts']) | set(entry['guard_paths'])
                                             | {p for p in entry['protected'] if needs_adaptation(p)})
    if git_try(repo, 'cat-file', '-e', ctx['upstream_sha'] + '^{commit}').returncode:
        fail('upstream objects are not present in the repository')
    protected_tests = load_policy_tests(repo, ctx['base_sha'])
    subjects = {c['sha']: c['subject'] for c in ctx['commits']}
    output.mkdir(parents=True, exist_ok=True)
    lines = ['# Upstream %s commits (%d)' % (ctx['release_tag'], len(shas)), '',
             'One patch per commit: %s/<sha>.patch. Marks: [P]=protected path (never applied), '
             '[T]=test file.' % output, '']
    for number, sha in enumerate(shas, 1):
        text, rows = export_commit(repo, sha, args.max_bytes, focus.get(sha))
        (output / (sha + '.patch')).write_text(text, encoding='utf-8')
        added = sum(int(r[0]) for r in rows if r[0].isdigit())
        removed = sum(int(r[1]) for r in rows if r[1].isdigit())
        lines.append('%d. %s %s' % (number, sha, subjects[sha]))
        lines.append('   %d files, +%d -%d' % (len(rows), added, removed))
        for ins, dele, path in rows[:40]:
            mark = ('[P]' if protection_reason(path, protected_tests) else '') + ('[T]' if is_test_path(path) else '')
            lines.append('   %s %s (+%s -%s)' % (mark or '   ', path, ins, dele))
        if len(rows) > 40:
            lines.append('   ... %d more files' % (len(rows) - 40))
        lines.append('')
    (output / 'digest.md').write_text('\n'.join(lines), encoding='utf-8')
    print(json.dumps({'commits': len(shas), 'directory': str(output)}))


def cmd_protected_paths(args):
    repo = open_repo(args.repo)
    output = outside_repo(repo, args.output)
    as_sha(args.base, 'base')
    protected_tests = load_policy_tests(repo, args.base)
    tracked = [p for p in tree_entries(repo, args.base + '^{tree}')]
    files = sorted({p for p in tracked if protection_reason(p, protected_tests)
                    and not any(p.casefold().startswith(x) for x in PROTECTED_PREFIXES)}
                   | {t for t in load_policy_tests(repo, args.base, fold=False) if not t.endswith('/')})
    prefixes = sorted(PROTECTED_PREFIXES)
    names = sorted({os.path.basename(p) for p in tracked if os.path.basename(p).casefold() in INSTRUCTION_NAMES})
    known = ['FORK.md', 'CLAUDE.md', 'AGENTS.md', '.gitmodules', '.gitattributes', '.mcp.json']
    fixed = sorted(k for k in PROTECTED_FILES if k not in ATTENTION_IGNORED_NAMES and k not in files)
    deny = ['.git/**'] + sorted(set(files) | set(fixed)) + [p + '**' if p.endswith('/') else p + '/**' for p in prefixes]
    deny += ['**/.claude/**', '**/.husky/**', '**/.githooks/**'] + ['**/' + n for n in sorted(set(names) | set(known))]
    for rule in deny:
        if not DENY_NAME.match(rule.replace('**', 'x').replace('*', 'x')):
            fail('cannot express %r as a permission rule' % rule)
    output.mkdir(parents=True, exist_ok=True)
    text = ['Protected paths: the guard rejects any added, modified or deleted file below.', '']
    text += ['  ' + p for p in sorted(set(files) | set(fixed))] + ['  ' + p + '**' for p in prefixes]
    text += ['  (any file named ' + ', '.join(sorted(INSTRUCTION_NAMES)) + ')',
             '  (anything inside ' + ', '.join(sorted(INSTRUCTION_DIRS)) + ')',
             '  package.json: name and scripts ' + ', '.join(PINNED_SCRIPTS) + ' must stay identical',
             '  existing test files may not be deleted; symlinks and submodules are not allowed', '']
    (output / 'protected-paths.txt').write_text('\n'.join(text), encoding='utf-8')
    (output / 'deny-rules.txt').write_text(','.join('Edit(/%s)' % r if not r.startswith('**') else 'Edit(%s)' % r
                                                    for r in deny), encoding='utf-8')
    print(json.dumps({'files': len(files), 'rules': len(deny)}))


# ------------------------------------------------------------------- commands

def fetch_latest_release():
    cmd = list(GH_COMMAND) + ['api', 'repos/%s/releases/latest' % UPSTREAM_REPO]
    try:
        p = subprocess.run(cmd, capture_output=True, timeout=120)
    except (OSError, subprocess.TimeoutExpired) as e:
        fail('cannot query the latest release: %s' % e)
    if p.returncode:
        fail('gh api failed: %s' % p.stderr.decode(errors='replace').strip())
    try:
        release = json.loads(p.stdout.decode('utf-8'))
    except ValueError as e:
        fail('latest release response is not JSON: %s' % e)
    if not isinstance(release, dict):
        fail('latest release response is not an object')
    return release


def previous_upstream(repo, base):
    listed = git_text(repo, 'ls-tree', base, '--', STATE_PATH)
    if not listed:
        return as_sha(INITIAL_UPSTREAM, 'initial upstream')
    state = json.loads(git(repo, 'cat-file', 'blob', '%s:%s' % (base, STATE_PATH)).decode('utf-8'))
    return validate_state(state)['reviewed_upstream']


def clean_subject(text):
    return ''.join(c if c.isprintable() else ' ' for c in text)[:200].strip()


def cmd_prepare(args):
    repo = open_repo(args.repo)
    output = outside_repo(repo, args.output)
    head = git_text(repo, 'rev-parse', 'HEAD')
    if args.base is not None and args.base != head:
        fail('stale base: HEAD is %s but the run is pinned to %s' % (head, args.base))
    if worktree_tree(repo) != git_text(repo, 'rev-parse', head + '^{tree}'):
        fail('checkout is not clean')
    if git_text(repo, 'rev-parse', '--is-shallow-repository') == 'true':
        fail('a full-history checkout is required (fetch-depth: 0)')
    previous = previous_upstream(repo, head)
    release = fetch_latest_release()
    tag = release.get('tag_name')
    if not isinstance(tag, str) or not TAG_RE.match(tag):
        fail('latest release tag %r is not a stable vX.Y.Z tag' % (tag,))
    if release.get('draft') is not False or release.get('prerelease') is not False:
        fail('latest release %s is a draft or prerelease' % tag)
    git(repo, 'fetch', '--quiet', '--no-tags', '--force', UPSTREAM_URL,
        '+refs/tags/%s:%s' % (tag, UPSTREAM_REF))
    upstream = git_text(repo, 'rev-parse', '--verify', UPSTREAM_REF + '^{commit}')
    commits = []
    if upstream != previous:
        rc = git_try(repo, 'merge-base', '--is-ancestor', previous, upstream).returncode
        if rc == 1:
            fail('release %s (%s) does not descend from the previously reviewed upstream %s'
                 % (tag, upstream, previous))
        if rc:
            fail('cannot compare release %s with previous upstream %s' % (tag, previous))
        raw = git(repo, 'log', '-z', '--reverse', '--topo-order', '--format=%H%x1f%s',
                  '%s..%s' % (previous, upstream)).decode('utf-8', 'replace')
        for record in filter(None, raw.split('\0')):
            sha, _, subject = record.partition('\x1f')
            commits.append({'sha': sha, 'subject': clean_subject(subject)})
    ctx = {'base_sha': head, 'release_tag': tag, 'upstream_sha': upstream,
           'previous_upstream': previous, 'commits': commits, 'pending': bool(commits)}
    validate_context(ctx)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(ctx, indent=2) + '\n', encoding='utf-8')
    print('prepared %s upstream=%s pending=%d' % (tag, upstream, len(commits)))


def cmd_guard(args):
    repo = open_repo(args.repo)
    print(guard_tree(repo, args.base))


def verify_context_commits(repo, ctx):
    """When the upstream objects are present, the context must match real history."""
    if git_try(repo, 'cat-file', '-e', ctx['upstream_sha'] + '^{commit}').returncode:
        return
    raw = git_text(repo, 'rev-list', '--reverse', '--topo-order',
                   '%s..%s' % (ctx['previous_upstream'], ctx['upstream_sha']))
    if raw.split() != [c['sha'] for c in ctx['commits']]:
        fail('context commits do not match upstream history')


def cmd_check_result(args):
    repo = open_repo(args.repo)
    ctx = load_context(args.context)
    if not ctx['pending']:
        fail('no upstream commits are pending')
    require_head(repo, ctx['base_sha'])
    selected, skipped = parse_result(args.result, ctx)
    print(json.dumps({'selected': len(selected), 'skipped': len(skipped)}))


def cmd_apply_selected(args):
    repo = open_repo(args.repo)
    report_path = outside_repo(repo, args.report)
    ctx = load_context(args.context)
    if not ctx['pending']:
        fail('no upstream commits are pending')
    base = ctx['base_sha']
    require_head(repo, base)
    if git_try(repo, 'cat-file', '-e', ctx['upstream_sha'] + '^{commit}').returncode:
        fail('upstream objects are not present in the repository')
    verify_context_commits(repo, ctx)
    base_tree = git_text(repo, 'rev-parse', base + '^{tree}')
    if worktree_tree(repo) != base_tree:
        fail('checkout is not clean')
    selected, skipped = parse_result(args.result, ctx)
    plan = mechanical_plan(repo, ctx, selected)
    materialize(repo, base_tree, plan['tree'])
    # Track what upstream added even where the fork's ignore rules match it, so only files the
    # editor creates later can count as ignored build output.
    git(repo, 'read-tree', plan['tree'])
    if guard_tree(repo, base) != plan['tree']:
        fail('the work tree does not match the planned tree after applying')
    plan['attention'] = attention_shas(plan)
    plan['selected'], plan['skipped'] = len(selected), len(skipped)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(plan, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'tree': plan['tree'], 'selected': len(selected), 'skipped': len(skipped),
                      'attention': len(plan['attention'])}))


def cmd_candidate(args):
    repo = open_repo(args.repo)
    patch_path = outside_repo(repo, args.patch)
    ctx = load_context(args.context)
    if not ctx['pending']:
        fail('no upstream commits are pending')
    base = ctx['base_sha']
    require_head(repo, base)
    verify_context_commits(repo, ctx)
    selected, skipped = parse_result(args.result, ctx)
    check_git_metadata(repo)
    # Recomputed from the object database, so nothing the editor could write affects it.
    plan = mechanical_plan(repo, ctx, selected)
    selected, skipped = parse_editor_result(args.editor_result, plan, attention_shas(plan), ctx,
                                            selected, skipped)
    guard_tree(repo, base)  # nothing, including the state file, may be touched by the agent
    state = {'reviewed_upstream': ctx['upstream_sha'], 'release_tag': ctx['release_tag'],
             'base_sha': base, 'selected': selected, 'skipped': skipped}
    validate_state(state, ctx)
    target = repo / STATE_PATH
    if os.path.islink(target) or os.path.islink(repo / '.github'):
        fail('state path must not be a symlink')
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(canonical_state(state))
    tree = guard_tree(repo, base, ctx)
    patch = git(repo, 'diff', '--binary', '--full-index', '--no-renames', '--no-ext-diff',
                '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', base + '^{tree}', tree)
    if not patch:
        fail('candidate produced an empty patch')
    patch_path.parent.mkdir(parents=True, exist_ok=True)
    patch_path.write_bytes(patch)
    print(json.dumps({'tree': tree, 'patch': str(patch_path),
                      'patch_sha256': hashlib.sha256(patch).hexdigest(),
                      'selected': len(selected), 'skipped': len(skipped)}))


def apply_checked_patch(repo, base, patch, ctx, expect_tree=None):
    patch_path = outside_repo(repo, patch)
    if ctx['base_sha'] != base:
        fail('context base_sha does not match --base')
    require_head(repo, base)
    base_tree = git_text(repo, 'rev-parse', base + '^{tree}')
    if worktree_tree(repo) != base_tree or git_text(repo, 'write-tree') != base_tree:
        fail('checkout is not clean')
    if not patch_path.is_file() or patch_path.stat().st_size == 0:
        fail('patch is missing or empty')
    git(repo, 'apply', '--index', '--whitespace=nowarn', str(patch_path))
    tree = guard_tree(repo, base, ctx)
    if git_text(repo, 'write-tree') != tree:
        fail('index and work tree disagree after applying the patch')
    if expect_tree is not None and tree != as_sha(expect_tree, 'expected tree'):
        fail('patched tree %s differs from the expected tree %s' % (tree, expect_tree))
    return tree


def cmd_check_patch(args):
    repo = open_repo(args.repo)
    ctx = load_context(args.context)
    print(apply_checked_patch(repo, args.base, args.patch, ctx, args.expect_tree))


def remote_tip(repo, remote):
    out = git_text(repo, 'ls-remote', remote, 'refs/heads/' + PERSONAL_BRANCH)
    lines = out.splitlines()
    if len(lines) != 1:
        fail('cannot determine the remote tip of %s' % PERSONAL_BRANCH)
    sha, _, ref = lines[0].partition('\t')
    if ref != 'refs/heads/' + PERSONAL_BRANCH:
        fail('unexpected ls-remote output')
    return as_sha(sha, 'remote tip')


def cmd_publish(args):
    if not REMOTE_RE.match(args.remote):
        fail('remote must be a plain remote name')
    repo = open_repo(args.repo)
    ctx = load_context(args.context)
    base = ctx['base_sha']
    require_head(repo, base)
    if remote_tip(repo, args.remote) != base:
        fail('stale base: %s moved since the run started' % PERSONAL_BRANCH)
    tree = apply_checked_patch(repo, base, args.patch, ctx, args.tree)
    state = json.loads((repo / STATE_PATH).read_text(encoding='utf-8'))
    subjects = {c['sha']: c['subject'] for c in ctx['commits']}
    lines = ['chore: apply upstream %s maintenance' % ctx['release_tag'], '',
             'Upstream release: ' + ctx['release_tag'],
             'Upstream commit: ' + ctx['upstream_sha'],
             'Previous reviewed upstream: ' + ctx['previous_upstream'],
             'Base: ' + base,
             'Selected: %d' % len(state['selected']),
             'Skipped: %d' % len(state['skipped']), '']
    if state['selected']:
        lines += ['Selected upstream commits:'] + ['- %s %s' % (s[:12], subjects[s]) for s in state['selected']] + ['']
    if state['skipped']:
        lines += ['Skipped upstream commits:'] + [
            '- %s %s: %s' % (s['sha'][:12], subjects[s['sha']], ' '.join(s['reason'].split())[:300])
            for s in state['skipped']] + ['']
    name, email = COMMIT_AUTHOR
    ident = {'GIT_AUTHOR_NAME': name, 'GIT_AUTHOR_EMAIL': email,
             'GIT_COMMITTER_NAME': name, 'GIT_COMMITTER_EMAIL': email}
    commit = git_text(repo, 'commit-tree', tree, '-p', base,
                      input=('\n'.join(lines)).encode('utf-8'), env=ident)
    # Plain refspec without "+": the remote rejects anything that is not a fast-forward.
    git(repo, 'push', '--no-verify', args.remote, '%s:refs/heads/%s' % (commit, PERSONAL_BRANCH))
    print(json.dumps({'commit': commit, 'tree': tree, 'branch': PERSONAL_BRANCH}))


# ----------------------------------------------------------------------- main

def build_parser():
    p = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    sub = p.add_subparsers(dest='command', required=True)
    c = sub.add_parser('prepare', help='resolve the latest stable upstream release and write the context JSON')
    c.add_argument('--repo', required=True)
    c.add_argument('--output', required=True, help='context JSON path, outside the repo')
    c.add_argument('--base', help='expected HEAD; refuse if different')
    c = sub.add_parser('export-upstream', help='write per-commit patches and a digest for the agents')
    c.add_argument('--repo', required=True)
    c.add_argument('--context', required=True)
    c.add_argument('--output', required=True, help='directory outside the repo')
    c.add_argument('--only-attention', help='apply report; export only the commits that need the editor')
    c.add_argument('--max-bytes', type=int, default=80000)
    c = sub.add_parser('check-result', help='validate the classification result against the context')
    c.add_argument('--repo', required=True)
    c.add_argument('--context', required=True)
    c.add_argument('--result', required=True)
    c = sub.add_parser('apply-selected', help='apply the selected commits with Git three-way merges')
    c.add_argument('--repo', required=True)
    c.add_argument('--context', required=True)
    c.add_argument('--result', required=True, help='classification JSON')
    c.add_argument('--report', required=True, help='apply report path, outside the repo')
    c = sub.add_parser('protected-paths', help='write the protected path list and edit deny rules')
    c.add_argument('--repo', required=True)
    c.add_argument('--base', required=True)
    c.add_argument('--output', required=True, help='directory outside the repo')
    c = sub.add_parser('guard', help='fail if the work tree differs from BASE in a forbidden way')
    c.add_argument('--repo', required=True)
    c.add_argument('--base', required=True)
    c = sub.add_parser('candidate', help='validate the agent result, write the state file, emit a patch')
    c.add_argument('--repo', required=True)
    c.add_argument('--context', required=True)
    c.add_argument('--result', required=True, help='Claude structured output JSON')
    c.add_argument('--patch', required=True, help='patch output path, outside the repo')
    c.add_argument('--editor-result', help='conflict-editor JSON; required exactly when commits need the editor')
    c = sub.add_parser('check-patch', help='apply a patch to a clean BASE checkout, guard it, print the tree id')
    c.add_argument('--repo', required=True)
    c.add_argument('--base', required=True)
    c.add_argument('--patch', required=True)
    c.add_argument('--context', required=True)
    c.add_argument('--expect-tree')
    c = sub.add_parser('publish', help='re-verify the patch and push one fast-forward commit (never forced)')
    c.add_argument('--repo', required=True)
    c.add_argument('--context', required=True)
    c.add_argument('--patch', required=True)
    c.add_argument('--tree', required=True, help='tree id printed by the tested check-patch run')
    c.add_argument('--remote', default='origin')
    return p


COMMANDS = {'prepare': cmd_prepare, 'export-upstream': cmd_export_upstream,
            'check-result': cmd_check_result, 'apply-selected': cmd_apply_selected,
            'protected-paths': cmd_protected_paths, 'guard': cmd_guard, 'candidate': cmd_candidate,
            'check-patch': cmd_check_patch, 'publish': cmd_publish}


def main(argv=None):
    args = build_parser().parse_args(argv)
    try:
        COMMANDS[args.command](args)
    except MaintenanceError as e:
        print('error: %s' % e, file=sys.stderr)
        return 1
    except Exception as e:  # fail closed on anything unexpected
        print('error: unexpected %s: %s' % (type(e).__name__, e), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
