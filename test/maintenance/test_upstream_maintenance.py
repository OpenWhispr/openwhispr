"""Tests for scripts/upstream-maintenance.py using real temporary git repositories.

Nothing here touches the network, the real upstream or any non-temporary path.
Run: python3 -m unittest discover -s test/maintenance -p 'test_upstream_maintenance.py'
"""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[2] / 'scripts' / 'upstream-maintenance.py'
spec = importlib.util.spec_from_file_location('upstream_maintenance', SCRIPT)
um = importlib.util.module_from_spec(spec)
spec.loader.exec_module(um)

IDENT = {
    'GIT_AUTHOR_NAME': 'Test', 'GIT_AUTHOR_EMAIL': 'test@example.invalid',
    'GIT_COMMITTER_NAME': 'Test', 'GIT_COMMITTER_EMAIL': 'test@example.invalid',
    'GIT_CONFIG_GLOBAL': os.devnull, 'GIT_CONFIG_NOSYSTEM': '1',
}
BRANCH = 'feat/byok-cleanup'
STATE = '.github/upstream-maintenance-state.json'


def git(cwd, *args, input=None, check=True):
    env = dict(os.environ, **IDENT)
    p = subprocess.run(['git', *args], cwd=str(cwd), env=env, input=input,
                       capture_output=True, check=False)
    if check and p.returncode:
        raise AssertionError('git %s failed: %s' % (' '.join(args), p.stderr.decode()))
    return p.stdout.decode().strip() if input is None or isinstance(input, str) else p.stdout


def write(root, rel, text='x\n', mode=None):
    path = Path(root) / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    if mode is not None:
        path.chmod(mode)
    return path


def cli(*argv):
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        try:
            rc = um.main([str(a) for a in argv])
        except SystemExit as e:
            rc = e.code
    return rc, out.getvalue(), err.getvalue()


POLICY = {
    'schema_version': 1,
    'protected_tests': ['test/helpers/fork.test.js'],
}


PACKAGE = {
    'name': 'open-whispr', 'version': '1.0.0',
    'scripts': {'typecheck': 'cd src && tsc --noEmit', 'lint': 'eslint .',
                'build:renderer': 'cd src && vite build', 'test': 'node --test',
                'postinstall': 'electron-builder install-app-deps', 'dev': 'vite'},
    'dependencies': {'left-pad': '1.0.0'},
}


class Fixture(unittest.TestCase):
    """upstream (bare) -> personal source repo at u0 + personal commit; tag v1.0.1 = u2."""

    @classmethod
    def setUpClass(cls):
        cls.root = Path(tempfile.mkdtemp(prefix='um-test-'))
        r = cls.root
        cls.up_work = r / 'up-work'
        cls.up_work.mkdir()
        git(cls.up_work, 'init', '-q', '-b', 'main')
        write(cls.up_work, 'package.json', '{}\n')
        write(cls.up_work, 'src/app.js', 'v0\n')
        write(cls.up_work, 'test/core.test.js', 'core\n')
        git(cls.up_work, 'add', '-A')
        git(cls.up_work, 'commit', '-q', '-m', 'u0 initial')
        cls.u0 = git(cls.up_work, 'rev-parse', 'HEAD')
        cls.source = r / 'source'
        git(r, 'clone', '-q', str(cls.up_work), str(cls.source))
        git(cls.source, 'checkout', '-q', '-b', BRANCH)
        write(cls.source, 'package.json', json.dumps(PACKAGE, indent=2) + '\n')
        write(cls.source, 'FORK.md', '# fork\n')
        write(cls.source, 'CLAUDE.md', '# claude\n')
        write(cls.source, '.github/personal-fork-policy.json', json.dumps(POLICY))
        write(cls.source, '.github/workflows/ci.yml', 'name: ci\n')
        write(cls.source, 'scripts/upstream-maintenance.py', '# helper\n')
        write(cls.source, 'scripts/verify-personal-fork.cjs', '// verify\n')
        write(cls.source, 'scripts/check-maintenance-tests.py', '# checks\n')
        write(cls.source, 'test/maintenance/test_x.py', '# t\n')
        write(cls.source, 'test/helpers/fork.test.js', 'fork\n')
        write(cls.source, 'docs/readme.md', 'docs\n')
        os.symlink('readme.md', cls.source / 'docs' / 'link')
        write(cls.source, '.gitignore', 'node_modules\ndist\n')
        git(cls.source, 'add', '-A')
        git(cls.source, 'commit', '-q', '-m', 'personal fork')
        cls.base = git(cls.source, 'rev-parse', 'HEAD')
        # upstream moves on: u1, u2 (release v1.0.1)
        write(cls.up_work, 'src/app.js', 'v1\n')
        git(cls.up_work, 'commit', '-qam', 'u1 fix crash')
        cls.u1 = git(cls.up_work, 'rev-parse', 'HEAD')
        write(cls.up_work, 'src/other.js', 'o\n')
        git(cls.up_work, 'add', '-A')
        git(cls.up_work, 'commit', '-qm', 'u2 add other')
        cls.u2 = git(cls.up_work, 'rev-parse', 'HEAD')
        git(cls.up_work, 'tag', '-a', 'v1.0.1', '-m', 'release', cls.u2)
        # a tag on an unrelated root commit
        git(cls.up_work, 'checkout', '-q', '--orphan', 'other')
        git(cls.up_work, 'rm', '-rqf', '.')
        write(cls.up_work, 'z.txt', 'z\n')
        git(cls.up_work, 'add', '-A')
        git(cls.up_work, 'commit', '-qm', 'unrelated')
        git(cls.up_work, 'tag', 'v9.0.0')
        cls.unrelated = git(cls.up_work, 'rev-parse', 'HEAD')
        cls.upstream = r / 'upstream.git'
        git(r, 'clone', '-q', '--bare', str(cls.up_work), str(cls.upstream))
        cls.gh_dir = r / 'gh'
        cls.gh_dir.mkdir()
        write(cls.gh_dir, 'gh.py', (
            'import json, pathlib, sys\n'
            'here = pathlib.Path(__file__).parent\n'
            'expected = ["api", "repos/OpenWhispr/openwhispr/releases/latest"]\n'
            'if sys.argv[1:3] != expected:\n'
            '    sys.stderr.write("unexpected args %r" % sys.argv[1:]); sys.exit(9)\n'
            'sys.stdout.write((here / "release.json").read_text())\n'))
        cls.n = 0

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.root, ignore_errors=True)

    def setUp(self):
        type(self).n += 1
        self.work = self.root / ('case%d' % self.n)
        self.work.mkdir()
        for name, value in (
            ('UPSTREAM_URL', str(self.upstream)),
            ('INITIAL_UPSTREAM', self.u0),
            ('GH_COMMAND', [sys.executable, str(self.gh_dir / 'gh.py')]),
        ):
            p = mock.patch.object(um, name, value)
            p.start()
            self.addCleanup(p.stop)
        self.set_release({'tag_name': 'v1.0.1', 'draft': False, 'prerelease': False})

    def set_release(self, data):
        (self.gh_dir / 'release.json').write_text(json.dumps(data))

    def clone(self, name='repo', src=None):
        dest = self.work / name
        git(self.work, 'clone', '-q', str(src or self.source), str(dest))
        git(dest, 'checkout', '-q', BRANCH)
        return dest

    def prepared(self, name='agent'):  # use distinct names when called repeatedly in one test
        repo = self.clone(name)
        ctx_path = self.work / (name + '-context.json')
        rc, out, err = cli('prepare', '--repo', repo, '--output', ctx_path)
        self.assertEqual(rc, 0, err)
        return repo, ctx_path, json.loads(ctx_path.read_text())

    def result_for(self, ctx, skip=(), name='result.json'):
        selected = [c['sha'] for c in ctx['commits'] if c['sha'] not in skip]
        skipped = [{'sha': s, 'reason': 'not applicable'} for s in skip]
        path = self.work / name
        path.write_text(json.dumps({'complete': True, 'selected': selected,
                                    'skipped': skipped, 'summary': 'done'}))
        return path

    def candidate(self, mutate=None, skip=(), name='agent'):
        repo, ctx_path, ctx = self.prepared(name)
        if mutate:
            mutate(repo)
        result = self.result_for(ctx, skip)
        patch = self.work / 'candidate.patch'
        rc, out, err = cli('candidate', '--repo', repo, '--context', ctx_path,
                           '--result', result, '--patch', patch)
        return repo, ctx_path, ctx, patch, rc, out, err

    def good_candidate(self, name='agent'):
        def edit(repo):
            write(repo, 'src/app.js', 'v1 merged\n')
        repo, ctx_path, ctx, patch, rc, out, err = self.candidate(edit, name=name)
        self.assertEqual(rc, 0, err)
        return repo, ctx_path, ctx, patch, json.loads(out)

    def patch_from(self, ctx_path, patch, mutate, name='tampered'):
        """Apply the valid patch in a scratch clone, mutate, return a new patch path."""
        scratch = self.clone(name + '-scratch')
        git(scratch, 'apply', '--index', str(patch))
        mutate(scratch)
        git(scratch, 'add', '-A')
        out = self.work / (name + '.patch')
        out.write_bytes(git(scratch, 'diff', '--cached', '--binary', '--full-index',
                            self.base, input=b''))
        return out


class PrepareTests(Fixture):
    def test_writes_context(self):
        repo, _, ctx = self.prepared()
        self.assertEqual(set(ctx), {'base_sha', 'release_tag', 'upstream_sha',
                                    'previous_upstream', 'commits', 'pending'})
        self.assertEqual(ctx['base_sha'], self.base)
        self.assertEqual(ctx['release_tag'], 'v1.0.1')
        self.assertEqual(ctx['upstream_sha'], self.u2)
        self.assertEqual(ctx['previous_upstream'], self.u0)
        self.assertTrue(ctx['pending'])
        self.assertEqual(ctx['commits'], [{'sha': self.u1, 'subject': 'u1 fix crash'},
                                          {'sha': self.u2, 'subject': 'u2 add other'}])
        self.assertEqual(git(repo, 'rev-parse', 'HEAD'), self.base)

    def test_calls_gh_with_fixed_arguments(self):
        # the fake gh exits 9 on any other argument vector
        self.prepared()

    def test_gh_failure_fails_closed(self):
        with mock.patch.object(um, 'GH_COMMAND', [sys.executable, '-c', 'import sys; sys.exit(3)']):
            repo = self.clone()
            rc, _, err = cli('prepare', '--repo', repo, '--output', self.work / 'c.json')
        self.assertEqual(rc, 1)
        self.assertFalse((self.work / 'c.json').exists())

    def test_prerelease_and_draft_are_refused(self):
        for data in ({'tag_name': 'v1.0.1', 'draft': False, 'prerelease': True},
                     {'tag_name': 'v1.0.1', 'draft': True, 'prerelease': False}):
            self.set_release(data)
            repo = self.clone('r%s' % data['prerelease'])
            rc, _, err = cli('prepare', '--repo', repo, '--output', self.work / 'c.json')
            self.assertEqual(rc, 1)
            self.assertFalse((self.work / 'c.json').exists())

    def test_non_stable_tag_names_are_refused(self):
        for tag in ('v1.0.1-rc.1', '1.0.1', 'v1.0', '../v1.0.1', 'v1.0.1 --upload-pack=x', 'main'):
            self.set_release({'tag_name': tag, 'draft': False, 'prerelease': False})
            repo = self.clone('t%d' % abs(hash(tag)))
            rc, _, _ = cli('prepare', '--repo', repo, '--output', self.work / 'c.json')
            self.assertEqual(rc, 1, tag)

    def test_non_descendant_release_is_refused(self):
        self.set_release({'tag_name': 'v9.0.0', 'draft': False, 'prerelease': False})
        repo = self.clone()
        rc, _, err = cli('prepare', '--repo', repo, '--output', self.work / 'c.json')
        self.assertEqual(rc, 1)
        self.assertIn('descend', err)

    def test_uses_reviewed_state_as_previous(self):
        repo = self.clone()
        state = {'reviewed_upstream': self.u1, 'release_tag': 'v1.0.0', 'base_sha': self.base,
                 'selected': [], 'skipped': []}
        write(repo, STATE, json.dumps(state))
        git(repo, 'add', '-A')
        git(repo, 'commit', '-qm', 'state')
        out = self.work / 'c.json'
        rc, _, err = cli('prepare', '--repo', repo, '--output', out)
        self.assertEqual(rc, 0, err)
        ctx = json.loads(out.read_text())
        self.assertEqual(ctx['previous_upstream'], self.u1)
        self.assertEqual([c['sha'] for c in ctx['commits']], [self.u2])
        self.assertEqual(ctx['base_sha'], git(repo, 'rev-parse', 'HEAD'))

    def test_release_older_than_reviewed_is_refused(self):
        repo = self.clone()
        state = {'reviewed_upstream': self.u2, 'release_tag': 'v1.0.1', 'base_sha': self.base,
                 'selected': [], 'skipped': []}
        write(repo, STATE, json.dumps(state))
        git(repo, 'add', '-A')
        git(repo, 'commit', '-qm', 'state')
        # a lower release tag pointing at u1 is an older release
        with mock.patch.object(um, 'fetch_latest_release',
                               return_value={'tag_name': 'v1.0.0', 'draft': False, 'prerelease': False}):
            git(self.upstream, 'tag', 'v1.0.0', self.u1)
            self.addCleanup(git, self.upstream, 'tag', '-d', 'v1.0.0')
            rc, _, err = cli('prepare', '--repo', repo, '--output', self.work / 'c.json')
        self.assertEqual(rc, 1)

    def test_same_release_is_not_pending(self):
        repo = self.clone()
        state = {'reviewed_upstream': self.u2, 'release_tag': 'v1.0.1', 'base_sha': self.base,
                 'selected': [], 'skipped': []}
        write(repo, STATE, json.dumps(state))
        git(repo, 'add', '-A')
        git(repo, 'commit', '-qm', 'state')
        out = self.work / 'c.json'
        rc, _, err = cli('prepare', '--repo', repo, '--output', out)
        self.assertEqual(rc, 0, err)
        ctx = json.loads(out.read_text())
        self.assertFalse(ctx['pending'])
        self.assertEqual(ctx['commits'], [])

    def test_malformed_state_is_refused(self):
        repo = self.clone()
        write(repo, STATE, '{"reviewed_upstream": "main"}')
        git(repo, 'add', '-A')
        git(repo, 'commit', '-qm', 'bad state')
        rc, _, _ = cli('prepare', '--repo', repo, '--output', self.work / 'c.json')
        self.assertEqual(rc, 1)

    def test_output_inside_repo_is_refused(self):
        repo = self.clone()
        rc, _, err = cli('prepare', '--repo', repo, '--output', repo / 'ctx.json')
        self.assertEqual(rc, 1)
        self.assertFalse((repo / 'ctx.json').exists())

    def test_dirty_checkout_is_refused(self):
        repo = self.clone()
        write(repo, 'src/app.js', 'dirty\n')
        rc, _, _ = cli('prepare', '--repo', repo, '--output', self.work / 'c.json')
        self.assertEqual(rc, 1)

    def test_pinned_base_must_match_head(self):
        repo = self.clone()
        rc, _, err = cli('prepare', '--repo', repo, '--output', self.work / 'c.json',
                         '--base', self.u0)
        self.assertEqual(rc, 1)
        self.assertIn('stale', err)


class GuardTests(Fixture):
    def guard(self, repo):
        return cli('guard', '--repo', repo, '--base', self.base)

    def test_unchanged_checkout_passes_and_prints_tree(self):
        repo = self.clone()
        rc, out, err = self.guard(repo)
        self.assertEqual(rc, 0, err)
        self.assertEqual(out.strip(), git(repo, 'rev-parse', 'HEAD^{tree}'))

    def test_ordinary_source_changes_are_allowed(self):
        repo = self.clone()
        write(repo, 'src/app.js', 'changed\n')
        write(repo, 'src/new.js', 'new\n')
        write(repo, 'test/new.test.js', 'new test\n')
        write(repo, 'node_modules/pkg/index.js', 'dep\n')
        write(repo, 'sub/node_modules/pkg/index.js', 'dep\n')
        (repo / 'src/new.js').chmod(0o755)
        rc, out, err = self.guard(repo)
        self.assertEqual(rc, 0, err)

    def test_blocked_changes(self):
        def modify(rel):
            return lambda r: write(r, rel, (r / rel).read_text() + 'more\n')

        def add(rel):
            return lambda r: write(r, rel, 'new\n')

        def delete(rel):
            return lambda r: (r / rel).unlink()

        def commit_fork(r):
            write(r, 'FORK.md', 'weakened\n')
            git(r, 'commit', '-qam', 'weaken')

        def symlink_changed(r):
            (r / 'docs/link').unlink()
            os.symlink('/etc/passwd', r / 'docs/link')

        def symlink_added(r):
            os.symlink('/etc/passwd', r / 'src/link')

        def nested_git(r):
            write(r, 'vendor/.git/config', 'x\n')

        def exec_deleted_state(r):
            write(r, STATE, '{}')

        def executable_instruction(r):
            write(r, 'tools/AGENTS.md', '#!/bin/sh\n', mode=0o755)

        cases = {
            'hermes instructions': add('.hermes.md'),
            'nested hermes instructions': add('src/deep/.hermes.md'),
            'nested CLAUDE.md': add('src/CLAUDE.md'),
            'claude settings local': add('.claude/settings.local.json'),
            'claude hook script': add('.claude/hooks/pre.sh'),
            'mcp config': add('.mcp.json'),
            'nested mcp config': add('tools/.mcp.json'),
            'gitattributes': add('.gitattributes'),
            'nested gitattributes': add('src/.gitattributes'),
            'husky hook': add('.husky/pre-commit'),
            'executable instruction': executable_instruction,
            'FORK.md': modify('FORK.md'),
            'FORK.md case variant': add('Fork.MD'),
            'CLAUDE.md': modify('CLAUDE.md'),
            'workflow modified': modify('.github/workflows/ci.yml'),
            'workflow added': add('.github/workflows/new.yml'),
            'policy': modify('.github/personal-fork-policy.json'),
            'state untrusted': exec_deleted_state,
            'helper script': modify('scripts/upstream-maintenance.py'),
            'verify script': modify('scripts/verify-personal-fork.cjs'),
            'checks script': modify('scripts/check-maintenance-tests.py'),
            'maintenance test modified': modify('test/maintenance/test_x.py'),
            'maintenance test added': add('test/maintenance/test_new.py'),
            'protected fork test': modify('test/helpers/fork.test.js'),
            'deleted upstream test': delete('test/core.test.js'),
            'deleted protected test': delete('test/helpers/fork.test.js'),
            'nested instruction file': add('src/AGENTS.md'),
            'claude dir': add('.claude/settings.json'),
            'cursor rules': add('.cursorrules'),
            'gitmodules': add('.gitmodules'),
            'symlink added': symlink_added,
            'symlink changed': symlink_changed,
            'symlink deleted': delete('docs/link'),
            'nested git dir': nested_git,
            'ignored file': add('dist/out.js'),
            'committed protected change': commit_fork,
        }
        for name, mutate in cases.items():
            with self.subTest(name):
                repo = self.clone('g-' + name.replace(' ', '-'))
                mutate(repo)
                rc, out, err = self.guard(repo)
                self.assertEqual(rc, 1, name)
                self.assertEqual(out, '')
                self.assertTrue(err.strip(), name)

    def test_unknown_base_and_bad_sha_fail(self):
        repo = self.clone()
        for base in ('0' * 40, 'HEAD', 'zzz'):
            rc, _, _ = cli('guard', '--repo', repo, '--base', base)
            self.assertEqual(rc, 1, base)

    def test_missing_policy_fails_closed(self):
        repo = self.clone()
        git(repo, 'rm', '-q', '.github/personal-fork-policy.json')
        git(repo, 'commit', '-qm', 'no policy')
        new_base = git(repo, 'rev-parse', 'HEAD')
        rc, _, err = cli('guard', '--repo', repo, '--base', new_base)
        self.assertEqual(rc, 1)
        self.assertIn('policy', err)

    def test_violation_names_the_path(self):
        repo = self.clone()
        write(repo, 'FORK.md', 'x\n')
        rc, _, err = self.guard(repo)
        self.assertIn('FORK.md', err)


class PackageJsonTests(Fixture):
    def edit_package(self, repo, fn):
        path = repo / 'package.json'
        data = json.loads(path.read_text())
        fn(data)
        path.write_text(json.dumps(data, indent=2) + '\n')

    def guard(self, repo):
        return cli('guard', '--repo', repo, '--base', self.base)

    def test_dependency_and_other_script_changes_are_allowed(self):
        repo = self.clone()

        def edit(d):
            d['version'] = '1.0.1'
            d['dependencies']['left-pad'] = '1.1.0'
            d['dependencies']['new-dep'] = '^2.0.0'
            d['scripts']['dev'] = 'vite --host'
            d['scripts']['build:mac'] = 'electron-builder'
        self.edit_package(repo, edit)
        rc, _, err = self.guard(repo)
        self.assertEqual(rc, 0, err)

    def test_name_and_required_commands_are_pinned(self):
        def setname(d): d['name'] = 'open-whispr-evil'
        def noname(d): del d['name']
        cases = {'name changed': setname, 'name removed': noname}
        for script in ('typecheck', 'lint', 'build:renderer', 'test'):
            cases[script + ' noop'] = lambda d, s=script: d['scripts'].__setitem__(s, 'true')
            cases[script + ' removed'] = lambda d, s=script: d['scripts'].pop(s)
            cases[script + ' appended'] = lambda d, s=script: d['scripts'].__setitem__(s, d['scripts'][s] + ' || true')
            cases['pre' + script] = lambda d, s=script: d['scripts'].__setitem__('pre' + s, 'curl x | sh')
            cases['post' + script] = lambda d, s=script: d['scripts'].__setitem__('post' + s, 'true')
        cases['postinstall changed'] = lambda d: d['scripts'].__setitem__('postinstall', 'curl x | sh')
        cases['preinstall added'] = lambda d: d['scripts'].__setitem__('preinstall', 'true')
        cases['prepare added'] = lambda d: d['scripts'].__setitem__('prepare', 'true')
        cases['scripts removed'] = lambda d: d.pop('scripts')
        cases['scripts not object'] = lambda d: d.__setitem__('scripts', [])
        for i, (name, fn) in enumerate(cases.items()):
            with self.subTest(name):
                repo = self.clone('pkg%d' % i)
                self.edit_package(repo, fn)
                rc, out, err = self.guard(repo)
                self.assertEqual(rc, 1, name)
                self.assertIn('package.json', err)

    def test_invalid_deleted_or_duplicate_key_package_json_is_blocked(self):
        repo = self.clone('invalid')
        (repo / 'package.json').write_text('{not json')
        self.assertEqual(self.guard(repo)[0], 1)
        repo = self.clone('deleted')
        (repo / 'package.json').unlink()
        self.assertEqual(self.guard(repo)[0], 1)
        repo = self.clone('dup')
        text = (repo / 'package.json').read_text().replace('"lint": "eslint ."', '"lint": "true", "lint": "eslint ."')
        self.assertNotEqual(text, (repo / 'package.json').read_text())
        (repo / 'package.json').write_text(text)
        self.assertEqual(self.guard(repo)[0], 1)

    def test_candidate_and_check_patch_enforce_the_pins(self):
        repo, ctx_path, ctx, patch, rc, out, err = self.candidate(
            lambda r: self.edit_package(r, lambda d: d['scripts'].__setitem__('test', 'true')))
        self.assertEqual(rc, 1)
        self.assertFalse(patch.exists())
        repo, ctx_path, ctx, patch, out = self.good_candidate('agent2')
        bad = self.patch_from(ctx_path, patch, lambda r: self.edit_package(
            r, lambda d: d['scripts'].__setitem__('lint', 'true')))
        rc, _, err = cli('check-patch', '--repo', self.clone('v'), '--base', self.base,
                         '--patch', bad, '--context', ctx_path)
        self.assertEqual(rc, 1)
        self.assertIn('package.json', err)

    def test_dependency_update_passes_through_candidate_and_check_patch(self):
        def edit(r):
            self.edit_package(r, lambda d: d['dependencies'].__setitem__('left-pad', '1.3.0'))
        repo, ctx_path, ctx, patch, rc, out, err = self.candidate(edit)
        self.assertEqual(rc, 0, err)
        rc, tree, err = cli('check-patch', '--repo', self.clone('v'), '--base', self.base,
                            '--patch', patch, '--context', ctx_path)
        self.assertEqual(rc, 0, err)


class CandidateTests(Fixture):
    def test_writes_patch_and_state(self):
        repo, ctx_path, ctx, patch, out = self.good_candidate()
        self.assertEqual(git(repo, 'rev-parse', 'HEAD'), self.base)
        state = json.loads((repo / STATE).read_text())
        self.assertEqual(state, {
            'reviewed_upstream': self.u2, 'release_tag': 'v1.0.1', 'base_sha': self.base,
            'selected': [self.u1, self.u2], 'skipped': []})
        self.assertTrue(patch.read_bytes().startswith(b'diff --git'))
        self.assertIn(STATE.encode(), patch.read_bytes())
        self.assertEqual(len(out['tree']), 40)
        # the patch is the diff from the base to the reported tree
        self.assertEqual(
            git(repo, 'diff', '--binary', '--full-index', '--no-renames', self.base + '^{tree}', out['tree'], input=b''),
            patch.read_bytes())

    def test_skipped_commits_are_recorded(self):
        def edit(repo):
            write(repo, 'src/app.js', 'v1 merged\n')
        repo, ctx_path, ctx, patch, rc, out, err = self.candidate(edit, skip=(self.u2,))
        self.assertEqual(rc, 0, err)
        state = json.loads((repo / STATE).read_text())
        self.assertEqual(state['selected'], [self.u1])
        self.assertEqual(state['skipped'], [{'sha': self.u2, 'reason': 'not applicable'}])

    def test_new_files_binary_and_exec_are_captured(self):
        def edit(repo):
            write(repo, 'src/tool.sh', '#!/bin/sh\n', mode=0o755)
            (repo / 'src/blob.bin').write_bytes(bytes(range(256)))
        repo, ctx_path, ctx, patch, rc, out, err = self.candidate(edit)
        self.assertEqual(rc, 0, err)
        verifier = self.clone('verifier')
        rc, out2, err2 = cli('check-patch', '--repo', verifier, '--base', self.base,
                             '--patch', patch, '--context', ctx_path)
        self.assertEqual(rc, 0, err2)
        self.assertEqual((verifier / 'src/blob.bin').read_bytes(), bytes(range(256)))
        self.assertTrue(os.stat(verifier / 'src/tool.sh').st_mode & stat.S_IXUSR)

    def test_node_modules_are_not_in_patch(self):
        def edit(repo):
            write(repo, 'node_modules/p/index.js', 'dep\n')
            write(repo, 'src/app.js', 'v1\n')
        repo, ctx_path, ctx, patch, rc, out, err = self.candidate(edit)
        self.assertEqual(rc, 0, err)
        self.assertNotIn(b'node_modules', patch.read_bytes())

    def test_malformed_results_are_refused(self):
        repo, ctx_path, ctx = self.prepared()
        a, b = (c['sha'] for c in ctx['commits'])
        sk = lambda *s: [{'sha': x, 'reason': 'r'} for x in s]
        good = {'complete': True, 'selected': [a, b], 'skipped': [], 'summary': 's'}
        cases = {
            'incomplete': dict(good, complete=False),
            'missing commit': dict(good, selected=[a]),
            'extra commit': dict(good, selected=[a, b, 'c' * 40]),
            'unknown commit only': dict(good, selected=[a, 'c' * 40]),
            'duplicate in selected': dict(good, selected=[a, a, b]),
            'in both': dict(good, selected=[a, b], skipped=sk(b)),
            'duplicate in skipped': dict(good, selected=[], skipped=sk(a, a, b)),
            'abbreviated sha': dict(good, selected=[a[:12], b]),
            'uppercase sha': dict(good, selected=[a.upper(), b]),
            'complete not bool': dict(good, complete='true'),
            'complete int': dict(good, complete=1),
            'selected not list': dict(good, selected=a),
            'skipped without reason': dict(good, selected=[a], skipped=[{'sha': b}]),
            'skipped empty reason': dict(good, selected=[a], skipped=[{'sha': b, 'reason': ''}]),
            'skipped extra key': dict(good, selected=[a], skipped=[{'sha': b, 'reason': 'r', 'x': 1}]),
            'skipped bare sha': dict(good, selected=[a], skipped=[b]),
            'summary missing': {k: v for k, v in good.items() if k != 'summary'},
            'summary not string': dict(good, summary=3),
            'unexpected key': dict(good, extra=1),
            'not an object': [good],
        }
        for name, data in cases.items():
            with self.subTest(name):
                result = self.work / 'r.json'
                result.write_text(json.dumps(data))
                patch = self.work / 'p.patch'
                write(repo, 'src/app.js', 'edit\n')
                rc, out, err = cli('candidate', '--repo', repo, '--context', ctx_path,
                                   '--result', result, '--patch', patch)
                self.assertEqual(rc, 1, name)
                self.assertFalse(patch.exists(), name)
        self.assertFalse((repo / STATE).exists())

    def test_invalid_json_result_is_refused(self):
        repo, ctx_path, ctx = self.prepared()
        result = self.work / 'bad.json'
        result.write_text('not json')
        rc, _, _ = cli('candidate', '--repo', repo, '--context', ctx_path,
                       '--result', result, '--patch', self.work / 'p.patch')
        self.assertEqual(rc, 1)

    def test_nothing_pending_is_refused(self):
        repo = self.clone()
        state = {'reviewed_upstream': self.u2, 'release_tag': 'v1.0.1', 'base_sha': self.base,
                 'selected': [], 'skipped': []}
        write(repo, STATE, json.dumps(state))
        git(repo, 'add', '-A')
        git(repo, 'commit', '-qm', 'state')
        ctx_path = self.work / 'c.json'
        self.assertEqual(cli('prepare', '--repo', repo, '--output', ctx_path)[0], 0)
        result = self.work / 'r.json'
        result.write_text(json.dumps({'complete': True, 'selected': [], 'skipped': [], 'summary': 's'}))
        rc, _, err = cli('candidate', '--repo', repo, '--context', ctx_path, '--result', result,
                         '--patch', self.work / 'p.patch')
        self.assertEqual(rc, 1)

    def test_moved_head_is_refused(self):
        def commit(repo):
            write(repo, 'src/app.js', 'committed\n')
            git(repo, 'commit', '-qam', 'agent committed')
        repo, ctx_path, ctx, patch, rc, out, err = self.candidate(commit)
        self.assertEqual(rc, 1)
        self.assertIn('HEAD', err)
        self.assertFalse(patch.exists())

    def test_guard_violation_blocks_patch(self):
        for rel in ('FORK.md', 'test/maintenance/test_x.py', STATE):
            with self.subTest(rel):
                def edit(repo, rel=rel):
                    write(repo, rel, 'tampered\n')
                repo, ctx_path, ctx, patch, rc, out, err = self.candidate(
                    edit, name='agent-' + str(abs(hash(rel))))
                self.assertEqual(rc, 1)
                self.assertFalse(patch.exists())

    def test_ignored_build_output_blocks_patch(self):
        repo, ctx_path, ctx, patch, rc, out, err = self.candidate(
            lambda r: write(r, 'dist/bundle.js', 'x\n'))
        self.assertEqual(rc, 1)
        self.assertFalse(patch.exists())

    def test_patch_inside_repo_is_refused(self):
        repo, ctx_path, ctx = self.prepared()
        result = self.result_for(ctx)
        rc, _, _ = cli('candidate', '--repo', repo, '--context', ctx_path, '--result', result,
                       '--patch', repo / 'out.patch')
        self.assertEqual(rc, 1)
        self.assertFalse((repo / 'out.patch').exists())

    def test_tampered_context_is_refused(self):
        repo, ctx_path, ctx = self.prepared()
        ctx['commits'] = ctx['commits'][:1]
        ctx_path.write_text(json.dumps(ctx))
        result = self.result_for(dict(ctx, commits=ctx['commits']))
        rc, _, _ = cli('candidate', '--repo', repo, '--context', ctx_path, '--result', result,
                       '--patch', self.work / 'p.patch')
        self.assertEqual(rc, 1)


class CheckPatchTests(Fixture):
    def check(self, repo, ctx_path, patch, *extra, base=None):
        return cli('check-patch', '--repo', repo, '--base', base or self.base,
                   '--patch', patch, '--context', ctx_path, *extra)

    def test_round_trip_tree_matches(self):
        repo, ctx_path, ctx, patch, out = self.good_candidate()
        verifier = self.clone('verifier')
        rc, stdout, err = self.check(verifier, ctx_path, patch)
        self.assertEqual(rc, 0, err)
        self.assertEqual(stdout.strip(), out['tree'])
        self.assertEqual(stdout.strip(), git(verifier, 'write-tree'))
        self.assertEqual((verifier / 'src/app.js').read_text(), 'v1 merged\n')
        rc, stdout, err = self.check(self.clone('v2'), ctx_path, patch, '--expect-tree', out['tree'])
        self.assertEqual(rc, 0, err)

    def test_expected_tree_mismatch_is_refused(self):
        repo, ctx_path, ctx, patch, out = self.good_candidate()
        rc, _, err = self.check(self.clone('v'), ctx_path, patch, '--expect-tree', '1' * 40)
        self.assertEqual(rc, 1)

    def test_stale_base_is_refused(self):
        repo, ctx_path, ctx, patch, out = self.good_candidate()
        verifier = self.clone('v')
        write(verifier, 'docs/other.md', 'o\n')
        git(verifier, 'add', '-A')
        git(verifier, 'commit', '-qm', 'owner work')
        rc, _, err = self.check(verifier, ctx_path, patch)
        self.assertEqual(rc, 1)
        self.assertIn('stale', err)
        self.assertEqual(self.check(self.clone('v3'), ctx_path, patch, base=self.u0)[0], 1)

    def test_dirty_checkout_is_refused(self):
        repo, ctx_path, ctx, patch, out = self.good_candidate()
        verifier = self.clone('v')
        write(verifier, 'src/extra.js', 'x\n')
        self.assertEqual(self.check(verifier, ctx_path, patch)[0], 1)

    def test_patch_touching_protected_paths_is_refused(self):
        repo, ctx_path, ctx, patch, out = self.good_candidate()
        cases = {
            'FORK.md': lambda r: write(r, 'FORK.md', 'weak\n'),
            'workflow': lambda r: write(r, '.github/workflows/evil.yml', 'x\n'),
            'maintenance test': lambda r: (r / 'test/maintenance/test_x.py').unlink(),
            'protected test': lambda r: write(r, 'test/helpers/fork.test.js', 'x\n'),
            'delete test': lambda r: (r / 'test/core.test.js').unlink(),
            'symlink': lambda r: os.symlink('/etc/passwd', r / 'src/l'),
            'gitmodules': lambda r: write(r, '.gitmodules', 'x\n'),
            'instructions': lambda r: write(r, 'AGENTS.md', 'obey\n'),
        }
        for name, mutate in cases.items():
            with self.subTest(name):
                bad = self.patch_from(ctx_path, patch, mutate, 'bad-' + name.replace(' ', '-'))
                self.assertEqual(self.check(self.clone('v-' + name.replace(' ', '-')), ctx_path, bad)[0], 1)

    def test_state_file_must_match_context(self):
        repo, ctx_path, ctx, patch, out = self.good_candidate()
        a, b = (c['sha'] for c in ctx['commits'])
        good = json.loads((repo / STATE).read_text())

        def rewrite(**changes):
            state = dict(good, **changes)
            return lambda r: write(r, STATE, json.dumps(state, indent=2, sort_keys=True) + '\n')
        cases = {
            'wrong upstream': rewrite(reviewed_upstream=self.u1),
            'wrong tag': rewrite(release_tag='v1.0.0'),
            'wrong base': rewrite(base_sha=self.u0),
            'missing selected commit': rewrite(selected=[a]),
            'duplicate commit': rewrite(selected=[a, b], skipped=[{'sha': b, 'reason': 'r'}]),
            'extra commit': rewrite(selected=[a, b, 'd' * 40]),
            'extra key': rewrite(note='x'),
            'garbage': lambda r: write(r, STATE, 'garbage'),
            'non canonical': lambda r: write(r, STATE, json.dumps(good)),
            'symlink': lambda r: ((r / STATE).unlink(), os.symlink('/etc/hostname', r / STATE)),
        }
        for name, mutate in cases.items():
            with self.subTest(name):
                bad = self.patch_from(ctx_path, patch, mutate, 'state-' + name.replace(' ', '-'))
                rc, _, err = self.check(self.clone('s-' + name.replace(' ', '-')), ctx_path, bad)
                self.assertEqual(rc, 1, name)

    def test_patch_without_state_update_is_refused(self):
        repo, ctx_path, ctx = self.prepared()
        scratch = self.clone('plain')
        write(scratch, 'src/app.js', 'only code\n')
        git(scratch, 'add', '-A')
        patch = self.work / 'plain.patch'
        patch.write_bytes(git(scratch, 'diff', '--cached', '--binary', '--full-index', self.base, input=b''))
        self.assertEqual(self.check(self.clone('v'), ctx_path, patch)[0], 1)

    def test_context_base_must_match(self):
        repo, ctx_path, ctx, patch, out = self.good_candidate()
        other = self.work / 'other-context.json'
        other.write_text(json.dumps(dict(ctx, base_sha=self.u0)))
        self.assertEqual(self.check(self.clone('v'), other, patch)[0], 1)

    def test_unapplicable_or_empty_patch_is_refused(self):
        repo, ctx_path, ctx, patch, out = self.good_candidate()
        empty = self.work / 'empty.patch'
        empty.write_bytes(b'')
        self.assertEqual(self.check(self.clone('v1'), ctx_path, empty)[0], 1)
        junk = self.work / 'junk.patch'
        junk.write_bytes(b'not a patch')
        self.assertEqual(self.check(self.clone('v2'), ctx_path, junk)[0], 1)

    def test_patch_inside_repo_is_refused(self):
        repo, ctx_path, ctx, patch, out = self.good_candidate()
        verifier = self.clone('v')
        inside = verifier / 'p.patch'
        shutil.copy(patch, inside)
        self.assertEqual(self.check(verifier, ctx_path, inside)[0], 1)


class PublishTests(Fixture):
    def setUp(self):
        super().setUp()
        self.origin = self.work / 'origin.git'
        git(self.work, 'clone', '-q', '--bare', str(self.source), str(self.origin))

    def publisher(self, name='pub'):
        dest = self.work / name
        git(self.work, 'clone', '-q', str(self.origin), str(dest))
        git(dest, 'checkout', '-q', BRANCH)
        return dest

    def publish(self, repo, ctx_path, patch, tree):
        return cli('publish', '--repo', repo, '--context', ctx_path, '--patch', patch,
                   '--tree', tree, '--remote', 'origin')

    def test_publishes_exact_tree_as_fast_forward(self):
        repo, ctx_path, ctx, patch, out = self.good_candidate()
        pub = self.publisher()
        rc, stdout, err = self.publish(pub, ctx_path, patch, out['tree'])
        self.assertEqual(rc, 0, err)
        info = json.loads(stdout)
        tip = git(self.origin, 'rev-parse', 'refs/heads/' + BRANCH)
        self.assertEqual(info['commit'], tip)
        self.assertEqual(git(self.origin, 'rev-parse', tip + '^{tree}'), out['tree'])
        self.assertEqual(git(self.origin, 'rev-list', '--parents', '-n1', tip).split(), [tip, self.base])
        message = git(self.origin, 'log', '-1', '--format=%B', tip)
        self.assertIn('v1.0.1', message)
        self.assertIn(self.u2, message)
        self.assertEqual(git(self.origin, 'tag', '-l'), '')

    def test_wrong_tree_is_refused_without_push(self):
        repo, ctx_path, ctx, patch, out = self.good_candidate()
        rc, _, err = self.publish(self.publisher(), ctx_path, patch, '2' * 40)
        self.assertEqual(rc, 1)
        self.assertEqual(git(self.origin, 'rev-parse', 'refs/heads/' + BRANCH), self.base)

    def test_stale_remote_aborts_and_keeps_owner_work(self):
        repo, ctx_path, ctx, patch, out = self.good_candidate()
        owner = self.publisher('owner')
        write(owner, 'docs/owner.md', 'owner\n')
        git(owner, 'add', '-A')
        git(owner, 'commit', '-qm', 'owner change')
        git(owner, 'push', '-q', 'origin', BRANCH)
        owner_tip = git(owner, 'rev-parse', 'HEAD')
        pub = self.publisher('pub')  # cloned after owner push: HEAD != base
        rc, _, err = self.publish(pub, ctx_path, patch, out['tree'])
        self.assertEqual(rc, 1)
        self.assertEqual(git(self.origin, 'rev-parse', 'refs/heads/' + BRANCH), owner_tip)

    def test_remote_moved_after_checkout_aborts(self):
        repo, ctx_path, ctx, patch, out = self.good_candidate()
        pub = self.publisher('pub')
        owner = self.publisher('owner')
        write(owner, 'docs/owner.md', 'owner\n')
        git(owner, 'add', '-A')
        git(owner, 'commit', '-qm', 'owner change')
        git(owner, 'push', '-q', 'origin', BRANCH)
        owner_tip = git(owner, 'rev-parse', 'HEAD')
        rc, _, err = self.publish(pub, ctx_path, patch, out['tree'])
        self.assertEqual(rc, 1)
        self.assertIn('stale', err)
        self.assertEqual(git(self.origin, 'rev-parse', 'refs/heads/' + BRANCH), owner_tip)

    def test_push_race_is_never_forced(self):
        repo, ctx_path, ctx, patch, out = self.good_candidate()
        pub = self.publisher('pub')
        owner = self.publisher('owner')
        write(owner, 'docs/owner.md', 'owner\n')
        git(owner, 'add', '-A')
        git(owner, 'commit', '-qm', 'owner change')
        git(owner, 'push', '-q', 'origin', BRANCH)
        owner_tip = git(owner, 'rev-parse', 'HEAD')
        # the tip check passes (as in a race between check and push) but the push must be rejected
        with mock.patch.object(um, 'remote_tip', return_value=self.base):
            rc, _, err = self.publish(pub, ctx_path, patch, out['tree'])
        self.assertEqual(rc, 1)
        self.assertEqual(git(self.origin, 'rev-parse', 'refs/heads/' + BRANCH), owner_tip)

    def test_patch_violation_is_refused_before_push(self):
        repo, ctx_path, ctx, patch, out = self.good_candidate()
        bad = self.patch_from(ctx_path, patch, lambda r: write(r, 'FORK.md', 'weak\n'))
        scratch = self.clone('t')
        git(scratch, 'apply', '--index', str(bad))
        rc, _, _ = self.publish(self.publisher(), ctx_path, bad, git(scratch, 'write-tree'))
        self.assertEqual(rc, 1)
        self.assertEqual(git(self.origin, 'rev-parse', 'refs/heads/' + BRANCH), self.base)

    def test_remote_name_must_be_a_plain_name(self):
        repo, ctx_path, ctx, patch, out = self.good_candidate()
        pub = self.publisher()
        for remote in ('--upload-pack=x', str(self.origin), 'a b'):
            rc, _, _ = cli('publish', '--repo', pub, '--context', ctx_path, '--patch', patch,
                           '--tree', out['tree'], '--remote=' + remote)
            self.assertEqual(rc, 1, remote)


class EntryPointTests(unittest.TestCase):
    def test_script_runs_as_a_program(self):
        p = subprocess.run([sys.executable, str(SCRIPT), '--help'], capture_output=True, text=True)
        self.assertEqual(p.returncode, 0)
        for command in ('prepare', 'guard', 'candidate', 'check-patch', 'publish'):
            self.assertIn(command, p.stdout)

    def test_unknown_command_is_usage_error(self):
        p = subprocess.run([sys.executable, str(SCRIPT), 'bogus'], capture_output=True, text=True)
        self.assertEqual(p.returncode, 2)

    def test_failure_exits_one_with_message_on_stderr(self):
        with tempfile.TemporaryDirectory() as d:
            p = subprocess.run([sys.executable, str(SCRIPT), 'guard', '--repo', d, '--base', '0' * 40],
                               capture_output=True, text=True)
        self.assertEqual(p.returncode, 1)
        self.assertEqual(p.stdout, '')
        self.assertTrue(p.stderr.startswith('error:'))


if __name__ == '__main__':
    unittest.main()
